// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {SeedlessEscrow, IERC20Escrow} from "../src/SeedlessEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract SeedlessEscrowTest is TestBase {
    event EscrowFunded(
        bytes32 indexed key, bytes32 indexed escrowId, address indexed client, address payee, uint256 total
    );

    MockUSDC internal usdc;
    SeedlessEscrow internal esc;

    address internal client;
    uint256 internal clientKey;
    address internal freelancer = makeAddr("freelancer");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant ID = keccak256("escrow-001");
    uint256 internal constant START = 1_800_000_000;
    uint256 internal constant BALANCE = 1_000_000e6;

    // Design $300, Build $500, Launch $200; due in 7, 21 and 30 days.
    uint256[] internal amounts;
    uint64[] internal dueIn;

    function setUp() public {
        vm.warp(START);
        usdc = new MockUSDC();
        esc = new SeedlessEscrow(IERC20Escrow(address(usdc)));
        (client, clientKey) = makeAddrAndKey("client");
        usdc.mint(client, BALANCE);
        usdc.mint(attacker, BALANCE);

        amounts.push(300e6);
        amounts.push(500e6);
        amounts.push(200e6);
        dueIn.push(7 days);
        dueIn.push(21 days);
        dueIn.push(30 days);
    }

    // ---------------------------------------------------------------- helpers

    function _fund() internal returns (bytes32 key) {
        vm.startPrank(client);
        usdc.approve(address(esc), 1_000e6);
        key = esc.fund(ID, freelancer, amounts, dueIn);
        vm.stopPrank();
    }

    function _status(bytes32 key, uint256 i) internal view returns (SeedlessEscrow.Status) {
        return esc.getMilestone(key, i).status;
    }

    function _deliver(bytes32 key, uint256 i) internal {
        vm.prank(freelancer);
        esc.markDelivered(key, i);
    }

    function _issue(bytes32 key, uint256 i) internal {
        vm.prank(client);
        esc.raiseIssue(key, i);
    }

    // ---------------------------------------------------------------- constructor

    function test_RevertWhen_TokenIsNotAContract() public {
        vm.expectRevert(SeedlessEscrow.InvalidToken.selector);
        new SeedlessEscrow(IERC20Escrow(makeAddr("eoa")));
    }

    // ---------------------------------------------------------------- funding

    function test_Fund_LocksTotalAndRecordsTerms() public {
        bytes32 expected = esc.escrowKey(ID, freelancer, amounts, dueIn);

        vm.prank(client);
        usdc.approve(address(esc), 1_000e6);
        vm.expectEmit(true, true, true, true, address(esc));
        emit EscrowFunded(expected, ID, client, freelancer, 1_000e6);
        vm.prank(client);
        bytes32 key = esc.fund(ID, freelancer, amounts, dueIn);

        assertTrue(key == expected, "key");
        assertEq(usdc.balanceOf(address(esc)), 1_000e6);
        assertEq(usdc.balanceOf(client), BALANCE - 1_000e6);

        (address c, address p, uint64 fundedAt, uint8 count) = esc.getEscrow(key);
        assertEq(c, client);
        assertEq(p, freelancer);
        assertEq(fundedAt, START);
        assertEq(count, 3);

        SeedlessEscrow.Milestone memory m = esc.getMilestone(key, 1);
        assertEq(m.amount, 500e6);
        assertEq(m.dueAt, START + 21 days);
        assertTrue(m.status == SeedlessEscrow.Status.Locked);
    }

    function test_RevertWhen_FundedTwice() public {
        _fund();
        vm.startPrank(client);
        usdc.approve(address(esc), 1_000e6);
        vm.expectRevert(SeedlessEscrow.AlreadyFunded.selector);
        esc.fund(ID, freelancer, amounts, dueIn);
        vm.stopPrank();
    }

    function test_AttackerCannotBlockEscrowWithDifferentTerms() public {
        uint256[] memory a = new uint256[](1);
        a[0] = 1;
        uint64[] memory d = new uint64[](1);
        d[0] = 1 days;
        vm.startPrank(attacker);
        usdc.approve(address(esc), 1);
        esc.fund(ID, freelancer, a, d);
        vm.stopPrank();

        bytes32 key = _fund();
        (address c,,,) = esc.getEscrow(key);
        assertEq(c, client);
    }

    function test_RevertWhen_PayeeIsZero() public {
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.ZeroPayee.selector);
        esc.fund(ID, address(0), amounts, dueIn);
    }

    function test_RevertWhen_ClientIsPayee() public {
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.SelfEscrow.selector);
        esc.fund(ID, client, amounts, dueIn);
    }

    function test_RevertWhen_NoMilestones() public {
        uint256[] memory a = new uint256[](0);
        uint64[] memory d = new uint64[](0);
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.BadMilestoneCount.selector);
        esc.fund(ID, freelancer, a, d);
    }

    function test_RevertWhen_TooManyMilestones() public {
        uint256[] memory a = new uint256[](6);
        uint64[] memory d = new uint64[](6);
        for (uint256 i; i < 6; ++i) {
            a[i] = 1e6;
            d[i] = 1 days;
        }
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.BadMilestoneCount.selector);
        esc.fund(ID, freelancer, a, d);
    }

    function test_FiveMilestonesAllowed() public {
        uint256[] memory a = new uint256[](5);
        uint64[] memory d = new uint64[](5);
        for (uint256 i; i < 5; ++i) {
            a[i] = 1e6;
            d[i] = 1 days;
        }
        vm.startPrank(client);
        usdc.approve(address(esc), 5e6);
        bytes32 key = esc.fund(ID, freelancer, a, d);
        vm.stopPrank();
        (,,, uint8 count) = esc.getEscrow(key);
        assertEq(count, 5);
    }

    function test_RevertWhen_LengthsDiffer() public {
        dueIn.pop();
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.BadMilestoneCount.selector);
        esc.fund(ID, freelancer, amounts, dueIn);
    }

    function test_RevertWhen_MilestoneAmountIsZero() public {
        amounts[1] = 0;
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.ZeroAmount.selector);
        esc.fund(ID, freelancer, amounts, dueIn);
    }

    function test_RevertWhen_DueIsZero() public {
        dueIn[0] = 0;
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.BadDueDate.selector);
        esc.fund(ID, freelancer, amounts, dueIn);
    }

    function test_RevertWhen_DueTooFar() public {
        dueIn[0] = uint64(esc.MAX_DUE() + 1);
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.BadDueDate.selector);
        esc.fund(ID, freelancer, amounts, dueIn);
    }

    function test_RevertWhen_NoAllowance() public {
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.TransferFailed.selector);
        esc.fund(ID, freelancer, amounts, dueIn);
    }

    function test_FundWithPermit_NoSeparateApproval() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(clientKey, client, 1_000e6, deadline);
        vm.prank(client);
        esc.fundWithPermit(ID, freelancer, amounts, dueIn, deadline, v, r, s);
        assertEq(usdc.balanceOf(address(esc)), 1_000e6);
    }

    function test_FundWithPermit_SucceedsWhenPermitFrontRun() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(clientKey, client, 1_000e6, deadline);
        vm.prank(attacker);
        usdc.permit(client, address(esc), 1_000e6, deadline, v, r, s);

        vm.prank(client);
        esc.fundWithPermit(ID, freelancer, amounts, dueIn, deadline, v, r, s);
        assertEq(usdc.balanceOf(address(esc)), 1_000e6);
    }

    // ---------------------------------------------------------------- happy path

    function test_FullHappyPath_AllMilestonesApproved() public {
        bytes32 key = _fund();
        for (uint256 i; i < 3; ++i) {
            _deliver(key, i);
            vm.prank(client);
            esc.approve(key, i);
            assertTrue(_status(key, i) == SeedlessEscrow.Status.Released);
        }
        assertEq(usdc.balanceOf(freelancer), 1_000e6);
        assertEq(usdc.balanceOf(address(esc)), 0, "nothing left behind");
    }

    function test_ClientCanApproveBeforeDelivery() public {
        bytes32 key = _fund();
        vm.prank(client);
        esc.approve(key, 0);
        assertEq(usdc.balanceOf(freelancer), 300e6);
    }

    function test_RevertWhen_ApprovedTwice() public {
        bytes32 key = _fund();
        vm.startPrank(client);
        esc.approve(key, 0);
        vm.expectRevert(SeedlessEscrow.WrongStatus.selector);
        esc.approve(key, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- review window (7 days)

    function test_FreelancerClaimsAfterSilentReview() public {
        bytes32 key = _fund();
        _deliver(key, 0);

        vm.warp(START + 7 days - 1);
        vm.prank(freelancer);
        vm.expectRevert(SeedlessEscrow.ReviewPeriodNotOver.selector);
        esc.claim(key, 0);

        vm.warp(START + 7 days);
        vm.prank(freelancer);
        esc.claim(key, 0);
        assertEq(usdc.balanceOf(freelancer), 300e6);
    }

    function test_RevertWhen_ClaimBeforeDelivery() public {
        bytes32 key = _fund();
        vm.warp(START + 60 days);
        vm.prank(freelancer);
        vm.expectRevert(SeedlessEscrow.WrongStatus.selector);
        esc.claim(key, 0);
    }

    function test_RevertWhen_IssueRaisedAfterReviewWindow() public {
        bytes32 key = _fund();
        _deliver(key, 0);
        vm.warp(START + 7 days);
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.ReviewPeriodOver.selector);
        esc.raiseIssue(key, 0);
    }

    function test_IssueBlocksClaim_RedeliveryRestartsReview() public {
        bytes32 key = _fund();
        _deliver(key, 0);
        vm.warp(START + 3 days);
        _issue(key, 0);

        vm.warp(START + 20 days);
        vm.prank(freelancer);
        vm.expectRevert(SeedlessEscrow.WrongStatus.selector);
        esc.claim(key, 0);

        _deliver(key, 0); // fixed and redelivered on day 20
        vm.warp(START + 27 days);
        vm.prank(freelancer);
        esc.claim(key, 0);
        assertEq(usdc.balanceOf(freelancer), 300e6);
    }

    // ---------------------------------------------------------------- refunds

    function test_ClientRefundsUndeliveredAfterDueDate() public {
        bytes32 key = _fund();

        vm.warp(START + 7 days - 1);
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.NotRefundableYet.selector);
        esc.refund(key, 0);

        vm.warp(START + 7 days);
        vm.prank(client);
        esc.refund(key, 0);
        assertTrue(_status(key, 0) == SeedlessEscrow.Status.Refunded);
        assertEq(usdc.balanceOf(client), BALANCE - 700e6);
    }

    function test_RevertWhen_RefundingDeliveredMilestone() public {
        bytes32 key = _fund();
        vm.warp(START + 6 days);
        _deliver(key, 0);
        vm.warp(START + 8 days); // past due, but it was delivered
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.NotRefundableYet.selector);
        esc.refund(key, 0);
    }

    function test_DeadlockReturnsToClientAfter30Days() public {
        bytes32 key = _fund();
        _deliver(key, 0);
        vm.warp(START + 1 days);
        _issue(key, 0);

        vm.warp(START + 31 days - 1);
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.NotRefundableYet.selector);
        esc.refund(key, 0);

        vm.warp(START + 31 days);
        vm.prank(client);
        esc.refund(key, 0);
        assertEq(usdc.balanceOf(client), BALANCE - 700e6);
    }

    function test_RedeliveryDoesNotResetDisputeClock() public {
        bytes32 key = _fund();
        _deliver(key, 0);
        vm.warp(START + 1 days);
        _issue(key, 0); // clock starts on day 1

        vm.warp(START + 29 days);
        _deliver(key, 0);
        vm.warp(START + 30 days);
        _issue(key, 0); // still unresolved

        vm.warp(START + 31 days);
        vm.prank(client);
        esc.refund(key, 0); // 30 days from the FIRST issue
        assertTrue(_status(key, 0) == SeedlessEscrow.Status.Refunded);
    }

    function test_FreelancerCanReturnToClient() public {
        bytes32 key = _fund();
        vm.prank(freelancer);
        esc.returnToClient(key, 2);
        assertEq(usdc.balanceOf(client), BALANCE - 800e6);
    }

    // ---------------------------------------------------------------- splits

    function test_SplitByAgreement() public {
        bytes32 key = _fund();
        _deliver(key, 1);
        _issue(key, 1);

        vm.prank(freelancer);
        esc.proposeSplit(key, 1, 350e6);
        vm.prank(client);
        esc.acceptSplit(key, 1, 350e6);

        assertTrue(_status(key, 1) == SeedlessEscrow.Status.Split);
        assertEq(usdc.balanceOf(freelancer), 350e6);
        assertEq(usdc.balanceOf(client), BALANCE - 1_000e6 + 150e6);
        assertEq(usdc.balanceOf(address(esc)), 500e6, "other milestones still locked");
    }

    function test_RevertWhen_AcceptingOwnProposal() public {
        bytes32 key = _fund();
        vm.startPrank(client);
        esc.proposeSplit(key, 0, 100e6);
        vm.expectRevert(SeedlessEscrow.NoMatchingProposal.selector);
        esc.acceptSplit(key, 0, 100e6);
        vm.stopPrank();
    }

    function test_RevertWhen_AcceptingChangedProposal() public {
        bytes32 key = _fund();
        vm.prank(client);
        esc.proposeSplit(key, 0, 100e6);
        vm.prank(client);
        esc.proposeSplit(key, 0, 10e6); // changed at the last moment
        vm.prank(freelancer);
        vm.expectRevert(SeedlessEscrow.NoMatchingProposal.selector);
        esc.acceptSplit(key, 0, 100e6);
    }

    function test_RevertWhen_SplitExceedsAmount() public {
        bytes32 key = _fund();
        vm.prank(freelancer);
        vm.expectRevert(SeedlessEscrow.BadSplit.selector);
        esc.proposeSplit(key, 0, 300e6 + 1);
    }

    function test_ProposalClearedWhenMilestoneCloses() public {
        bytes32 key = _fund();
        vm.prank(freelancer);
        esc.proposeSplit(key, 0, 100e6);
        vm.prank(client);
        esc.approve(key, 0);
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.WrongStatus.selector);
        esc.acceptSplit(key, 0, 100e6);
    }

    // ---------------------------------------------------------------- access control

    function test_OutsidersCannotMoveFunds() public {
        bytes32 key = _fund();
        _deliver(key, 0);
        vm.warp(START + 60 days);

        vm.startPrank(attacker);
        vm.expectRevert(SeedlessEscrow.NotClient.selector);
        esc.approve(key, 0);
        vm.expectRevert(SeedlessEscrow.NotClient.selector);
        esc.refund(key, 1);
        vm.expectRevert(SeedlessEscrow.NotPayee.selector);
        esc.claim(key, 0);
        vm.expectRevert(SeedlessEscrow.NotPayee.selector);
        esc.returnToClient(key, 0);
        vm.expectRevert(SeedlessEscrow.NotPayee.selector);
        esc.markDelivered(key, 1);
        vm.expectRevert(SeedlessEscrow.NotParty.selector);
        esc.proposeSplit(key, 0, 0);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(esc)), 1_000e6);
    }

    function test_ClientCannotClaimAndFreelancerCannotRefund() public {
        bytes32 key = _fund();
        _deliver(key, 0);
        vm.warp(START + 60 days);

        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.NotPayee.selector);
        esc.claim(key, 0);
        vm.prank(freelancer);
        vm.expectRevert(SeedlessEscrow.NotClient.selector);
        esc.refund(key, 1);
    }

    function test_RevertWhen_UnknownEscrowOrBadIndex() public {
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.UnknownEscrow.selector);
        esc.approve(keccak256("nope"), 0);

        bytes32 key = _fund();
        vm.prank(client);
        vm.expectRevert(SeedlessEscrow.BadIndex.selector);
        esc.approve(key, 3);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_SplitConservesFunds(uint256 toPayee) public {
        toPayee = bound(toPayee, 0, 300e6);
        bytes32 key = _fund();
        vm.prank(client);
        esc.proposeSplit(key, 0, toPayee);
        vm.prank(freelancer);
        esc.acceptSplit(key, 0, toPayee);

        assertEq(usdc.balanceOf(freelancer), toPayee);
        assertEq(usdc.balanceOf(client) + usdc.balanceOf(freelancer) + usdc.balanceOf(address(esc)), BALANCE);
        assertEq(usdc.balanceOf(address(esc)), 700e6);
    }

    // ---------------------------------------------------------------- permit helper

    function _signPermit(uint256 key, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(usdc.PERMIT_TYPEHASH(), owner, address(esc), value, usdc.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(key, digest);
    }
}
