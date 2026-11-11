// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TestBase} from "./utils/TestBase.sol";
import {SeedlessPay, IERC20} from "../src/SeedlessPay.sol";
import {MockUSDC, FalseToken} from "./mocks/MockUSDC.sol";

contract SeedlessPayTest is TestBase {
    event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, address indexed payee, uint256 amount);

    MockUSDC internal usdc;
    SeedlessPay internal pay;

    address internal client;
    uint256 internal clientKey;
    address internal freelancer = makeAddr("freelancer");
    address internal attacker = makeAddr("attacker");

    bytes32 internal constant INVOICE = keccak256("invoice-001");
    uint256 internal constant AMOUNT = 250e6; // 250 USDC

    function setUp() public {
        usdc = new MockUSDC();
        pay = new SeedlessPay(IERC20(address(usdc)));
        (client, clientKey) = makeAddrAndKey("client");
        usdc.mint(client, 1_000_000e6);
        usdc.mint(attacker, 1_000_000e6);
    }

    // ---------------------------------------------------------------- constructor

    function test_Constructor_SetsToken() public view {
        assertEq(address(pay.token()), address(usdc));
    }

    function test_RevertWhen_TokenIsNotAContract() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(SeedlessPay.InvalidToken.selector);
        new SeedlessPay(IERC20(eoa));
    }

    // ---------------------------------------------------------------- payInvoice

    function test_PayInvoice_MovesFundsAndEmits() public {
        vm.prank(client);
        usdc.approve(address(pay), AMOUNT);

        vm.expectEmit(true, true, true, true, address(pay));
        emit InvoicePaid(INVOICE, client, freelancer, AMOUNT);

        vm.prank(client);
        pay.payInvoice(INVOICE, freelancer, AMOUNT);

        assertEq(usdc.balanceOf(freelancer), AMOUNT);
        assertEq(usdc.balanceOf(client), 1_000_000e6 - AMOUNT);
        assertEq(usdc.balanceOf(address(pay)), 0, "contract must never hold funds");
        assertTrue(pay.isPaid(INVOICE, freelancer, AMOUNT));
    }

    function test_RevertWhen_PaidTwice() public {
        vm.startPrank(client);
        usdc.approve(address(pay), AMOUNT * 2);
        pay.payInvoice(INVOICE, freelancer, AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(SeedlessPay.AlreadyPaid.selector, INVOICE));
        pay.payInvoice(INVOICE, freelancer, AMOUNT);
        vm.stopPrank();

        assertEq(usdc.balanceOf(freelancer), AMOUNT, "freelancer paid exactly once");
    }

    function test_AttackerCannotBlockInvoiceWithDifferentTerms() public {
        // Attacker front-runs with the same invoice id but a 1-unit payment to themselves.
        vm.startPrank(attacker);
        usdc.approve(address(pay), 1);
        pay.payInvoice(INVOICE, attacker, 1);
        vm.stopPrank();

        assertFalse(pay.isPaid(INVOICE, freelancer, AMOUNT));

        vm.startPrank(client);
        usdc.approve(address(pay), AMOUNT);
        pay.payInvoice(INVOICE, freelancer, AMOUNT);
        vm.stopPrank();

        assertEq(usdc.balanceOf(freelancer), AMOUNT);
        assertTrue(pay.isPaid(INVOICE, freelancer, AMOUNT));
    }

    function test_RevertWhen_PayeeIsZero() public {
        vm.prank(client);
        vm.expectRevert(SeedlessPay.ZeroPayee.selector);
        pay.payInvoice(INVOICE, address(0), AMOUNT);
    }

    function test_RevertWhen_AmountIsZero() public {
        vm.prank(client);
        vm.expectRevert(SeedlessPay.ZeroAmount.selector);
        pay.payInvoice(INVOICE, freelancer, 0);
    }

    function test_RevertWhen_NoAllowance() public {
        vm.prank(client);
        vm.expectRevert(SeedlessPay.TransferFailed.selector);
        pay.payInvoice(INVOICE, freelancer, AMOUNT);

        assertFalse(pay.isPaid(INVOICE, freelancer, AMOUNT), "failed payment must not mark the invoice paid");
    }

    function test_RevertWhen_InsufficientBalance() public {
        address broke = makeAddr("broke");
        vm.startPrank(broke);
        usdc.approve(address(pay), AMOUNT);
        vm.expectRevert(SeedlessPay.TransferFailed.selector);
        pay.payInvoice(INVOICE, freelancer, AMOUNT);
        vm.stopPrank();
    }

    function test_RevertWhen_TokenReturnsFalse() public {
        SeedlessPay falsePay = new SeedlessPay(IERC20(address(new FalseToken())));
        vm.prank(client);
        vm.expectRevert(SeedlessPay.TransferFailed.selector);
        falsePay.payInvoice(INVOICE, freelancer, AMOUNT);
    }

    // ---------------------------------------------------------------- payInvoiceWithPermit

    function test_PayWithPermit_NoSeparateApproval() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(clientKey, client, AMOUNT, deadline);

        vm.prank(client);
        pay.payInvoiceWithPermit(INVOICE, freelancer, AMOUNT, deadline, v, r, s);

        assertEq(usdc.balanceOf(freelancer), AMOUNT);
        assertEq(usdc.allowance(client, address(pay)), 0, "permit allowance fully used");
        assertTrue(pay.isPaid(INVOICE, freelancer, AMOUNT));
    }

    function test_PayWithPermit_SucceedsWhenPermitFrontRun() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(clientKey, client, AMOUNT, deadline);

        // Someone copies the signature from the mempool and submits the permit first.
        vm.prank(attacker);
        usdc.permit(client, address(pay), AMOUNT, deadline, v, r, s);

        vm.prank(client);
        pay.payInvoiceWithPermit(INVOICE, freelancer, AMOUNT, deadline, v, r, s);

        assertEq(usdc.balanceOf(freelancer), AMOUNT);
    }

    function test_RevertWhen_PermitInvalidAndNoAllowance() public {
        uint256 deadline = block.timestamp + 1 hours;
        (, uint256 wrongKey) = makeAddrAndKey("wrong");
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(wrongKey, client, AMOUNT, deadline);

        vm.prank(client);
        vm.expectRevert(SeedlessPay.TransferFailed.selector);
        pay.payInvoiceWithPermit(INVOICE, freelancer, AMOUNT, deadline, v, r, s);
    }

    function test_RevertWhen_PermitSignedByClientIsUsedByAnotherCaller() public {
        // The permit authorises `client` funds only; another caller cannot redirect it.
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(clientKey, client, AMOUNT, deadline);

        vm.prank(attacker);
        vm.expectRevert(SeedlessPay.TransferFailed.selector);
        pay.payInvoiceWithPermit(INVOICE, attacker, AMOUNT, deadline, v, r, s);

        assertEq(usdc.balanceOf(client), 1_000_000e6, "client funds untouched");
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_PayInvoice(bytes32 invoiceId, uint256 amount) public {
        amount = bound(amount, 1, 1_000_000e6);

        vm.startPrank(client);
        usdc.approve(address(pay), amount);
        pay.payInvoice(invoiceId, freelancer, amount);
        vm.stopPrank();

        assertEq(usdc.balanceOf(freelancer), amount);
        assertEq(usdc.balanceOf(address(pay)), 0);
        assertTrue(pay.isPaid(invoiceId, freelancer, amount));
    }

    // ---------------------------------------------------------------- helpers

    function _signPermit(uint256 key, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(usdc.PERMIT_TYPEHASH(), owner, address(pay), value, usdc.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(key, digest);
    }
}
