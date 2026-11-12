// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The ERC-20 functions SeedlessEscrow needs.
interface IERC20Escrow {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice EIP-2612 permit, supported by native USDC on Avalanche.
interface IERC20PermitEscrow {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title SeedlessEscrow
/// @notice Milestone escrow for freelancer invoices paid in USDC.
///
///         The client locks the full amount up front. Each milestone is then settled on its own:
///
///         - The freelancer marks a milestone delivered. The client has 7 days to approve it or
///           raise an issue. If the client does neither, the freelancer can claim it.
///         - The client can approve (release) a milestone at any time.
///         - If a milestone is not delivered by its due date, the client can take it back.
///         - If the client raises an issue and it is still unresolved 30 days later, the client
///           can take that milestone back. Redelivering does not restart this 30-day clock.
///         - Either side can propose a split; it happens when the other side accepts the same
///           numbers. The freelancer can also return a milestone to the client at any time.
///
/// @dev No owner, no admin, no upgrade path, no fees. Nobody but the client and the freelancer
///      can move an escrow's funds, and only along the rules above. An escrow is identified by
///      the hash of its full terms, so a third party cannot block it by funding the same id with
///      different terms. Funding the exact same terms twice is rejected.
contract SeedlessEscrow {
    enum Status {
        None,
        Locked, // funded, waiting for delivery
        Delivered, // delivered, client review window running
        Disputed, // client raised an issue
        Released, // paid to the freelancer
        Refunded, // returned to the client
        Split // divided by agreement
    }

    struct Escrow {
        address client;
        address payee;
        uint64 fundedAt;
        uint8 count;
    }

    struct Milestone {
        uint128 amount;
        uint64 dueAt;
        uint64 deliveredAt;
        uint64 disputedAt; // first time an issue was raised; never reset
        Status status;
        address splitProposer;
        uint128 splitToPayee;
    }

    /// @notice How long the client has to review a delivery before the freelancer can claim it.
    uint256 public constant REVIEW_PERIOD = 7 days;
    /// @notice How long an issue can stay unresolved before the client can take the milestone back.
    uint256 public constant DISPUTE_PERIOD = 30 days;
    /// @notice Most milestones in one escrow.
    uint256 public constant MAX_MILESTONES = 5;
    /// @notice Latest a milestone can be due, counted from funding.
    uint256 public constant MAX_DUE = 730 days;

    /// @notice The stablecoin escrows are paid in (USDC).
    IERC20Escrow public immutable token;

    mapping(bytes32 key => Escrow) private _escrows;
    mapping(bytes32 key => mapping(uint256 index => Milestone)) private _milestones;

    event EscrowFunded(
        bytes32 indexed key, bytes32 indexed escrowId, address indexed client, address payee, uint256 total
    );
    event MilestoneDelivered(bytes32 indexed key, uint256 indexed index);
    event IssueRaised(bytes32 indexed key, uint256 indexed index);
    event MilestoneReleased(bytes32 indexed key, uint256 indexed index, address indexed payee, uint256 amount);
    event MilestoneRefunded(bytes32 indexed key, uint256 indexed index, address indexed client, uint256 amount);
    event SplitProposed(bytes32 indexed key, uint256 indexed index, address indexed proposer, uint256 toPayee);
    event MilestoneSplit(bytes32 indexed key, uint256 indexed index, uint256 toPayee, uint256 toClient);

    error InvalidToken();
    error ZeroPayee();
    error SelfEscrow();
    error BadMilestoneCount();
    error ZeroAmount();
    error AmountTooLarge();
    error BadDueDate();
    error AlreadyFunded();
    error UnknownEscrow();
    error BadIndex();
    error NotClient();
    error NotPayee();
    error NotParty();
    error WrongStatus();
    error ReviewPeriodOver();
    error ReviewPeriodNotOver();
    error NotRefundableYet();
    error BadSplit();
    error NoMatchingProposal();
    error TransferFailed();

    constructor(IERC20Escrow token_) {
        if (address(token_).code.length == 0) revert InvalidToken();
        token = token_;
    }

    // ------------------------------------------------------------------ funding

    /// @notice Locks the full amount for an escrow. The caller becomes the client and must have
    ///         approved this contract for the total.
    /// @param escrowId The invoice id chosen by the freelancer's app.
    /// @param payee The freelancer.
    /// @param amounts USDC amount per milestone (6 decimals).
    /// @param dueIn Seconds after funding when each milestone is due.
    /// @return key The escrow's key, used by every other function.
    function fund(bytes32 escrowId, address payee, uint256[] calldata amounts, uint64[] calldata dueIn)
        external
        returns (bytes32 key)
    {
        return _fund(escrowId, payee, amounts, dueIn);
    }

    /// @notice Same as `fund`, approving the total in the same transaction with an EIP-2612 permit
    ///         signed by the caller.
    /// @dev If someone submits the same permit first, the allowance is already in place, so a
    ///      failed permit is ignored and the transfer decides the outcome.
    function fundWithPermit(
        bytes32 escrowId,
        address payee,
        uint256[] calldata amounts,
        uint64[] calldata dueIn,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 key) {
        _permit(_sum(amounts), deadline, v, r, s);
        return _fund(escrowId, payee, amounts, dueIn);
    }

    // ------------------------------------------------------------------ freelancer

    /// @notice Marks a milestone as delivered and starts the client's review window.
    ///         Also used to redeliver after the client raised an issue.
    function markDelivered(bytes32 key, uint256 index) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.payee) revert NotPayee();
        Milestone storage m = _milestone(key, e, index);
        if (m.status != Status.Locked && m.status != Status.Disputed) revert WrongStatus();

        m.status = Status.Delivered;
        m.deliveredAt = uint64(block.timestamp);
        emit MilestoneDelivered(key, index);
    }

    /// @notice Pays a delivered milestone to the freelancer once the review window has passed
    ///         without the client approving or raising an issue.
    function claim(bytes32 key, uint256 index) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.payee) revert NotPayee();
        Milestone storage m = _milestone(key, e, index);
        if (m.status != Status.Delivered) revert WrongStatus();
        if (block.timestamp < uint256(m.deliveredAt) + REVIEW_PERIOD) revert ReviewPeriodNotOver();

        _release(key, index, e, m);
    }

    /// @notice Returns an open milestone to the client. Only the freelancer can do this.
    function returnToClient(bytes32 key, uint256 index) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.payee) revert NotPayee();
        Milestone storage m = _milestone(key, e, index);
        if (!_isOpen(m.status)) revert WrongStatus();

        _refund(key, index, e, m);
    }

    // ------------------------------------------------------------------ client

    /// @notice Pays an open milestone to the freelancer. The client can do this at any time.
    function approve(bytes32 key, uint256 index) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.client) revert NotClient();
        Milestone storage m = _milestone(key, e, index);
        if (!_isOpen(m.status)) revert WrongStatus();

        _release(key, index, e, m);
    }

    /// @notice Stops a delivered milestone from being claimed. Must be called within the review
    ///         window. Starts the 30-day dispute clock the first time only.
    function raiseIssue(bytes32 key, uint256 index) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.client) revert NotClient();
        Milestone storage m = _milestone(key, e, index);
        if (m.status != Status.Delivered) revert WrongStatus();
        if (block.timestamp >= uint256(m.deliveredAt) + REVIEW_PERIOD) revert ReviewPeriodOver();

        m.status = Status.Disputed;
        if (m.disputedAt == 0) m.disputedAt = uint64(block.timestamp);
        emit IssueRaised(key, index);
    }

    /// @notice Takes a milestone back. Allowed when it was never delivered and is past its due
    ///         date, or when an issue has been open for 30 days since it was first raised.
    function refund(bytes32 key, uint256 index) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.client) revert NotClient();
        Milestone storage m = _milestone(key, e, index);

        bool overdue = m.status == Status.Locked && block.timestamp >= m.dueAt;
        bool deadlocked =
            m.status == Status.Disputed && block.timestamp >= uint256(m.disputedAt) + DISPUTE_PERIOD;
        if (!overdue && !deadlocked) revert NotRefundableYet();

        _refund(key, index, e, m);
    }

    // ------------------------------------------------------------------ either side

    /// @notice Proposes dividing an open milestone: `toPayee` to the freelancer, the rest back to
    ///         the client. Replaces any earlier proposal.
    function proposeSplit(bytes32 key, uint256 index, uint256 toPayee) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.client && msg.sender != e.payee) revert NotParty();
        Milestone storage m = _milestone(key, e, index);
        if (!_isOpen(m.status)) revert WrongStatus();
        if (toPayee > m.amount) revert BadSplit();

        m.splitProposer = msg.sender;
        m.splitToPayee = uint128(toPayee);
        emit SplitProposed(key, index, msg.sender, toPayee);
    }

    /// @notice Accepts the other side's split proposal. `toPayee` must match the proposal, so a
    ///         proposal changed at the last moment cannot be accepted by mistake.
    function acceptSplit(bytes32 key, uint256 index, uint256 toPayee) external {
        Escrow storage e = _escrow(key);
        if (msg.sender != e.client && msg.sender != e.payee) revert NotParty();
        Milestone storage m = _milestone(key, e, index);
        if (!_isOpen(m.status)) revert WrongStatus();
        address proposer = m.splitProposer;
        if (proposer == address(0) || proposer == msg.sender || m.splitToPayee != toPayee) {
            revert NoMatchingProposal();
        }

        uint256 amount = m.amount;
        uint256 toClient = amount - toPayee;
        m.status = Status.Split;
        m.splitProposer = address(0);

        if (toPayee != 0) _safeTransfer(e.payee, toPayee);
        if (toClient != 0) _safeTransfer(e.client, toClient);
        emit MilestoneSplit(key, index, toPayee, toClient);
    }

    // ------------------------------------------------------------------ views

    /// @notice The key for an escrow's terms.
    function escrowKey(bytes32 escrowId, address payee, uint256[] calldata amounts, uint64[] calldata dueIn)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(escrowId, payee, keccak256(abi.encodePacked(amounts, dueIn))));
    }

    function getEscrow(bytes32 key)
        external
        view
        returns (address client, address payee, uint64 fundedAt, uint8 count)
    {
        Escrow storage e = _escrows[key];
        return (e.client, e.payee, e.fundedAt, e.count);
    }

    function getMilestone(bytes32 key, uint256 index) external view returns (Milestone memory) {
        return _milestones[key][index];
    }

    // ------------------------------------------------------------------ internal

    function _fund(bytes32 escrowId, address payee, uint256[] calldata amounts, uint64[] calldata dueIn)
        private
        returns (bytes32 key)
    {
        if (payee == address(0)) revert ZeroPayee();
        if (payee == msg.sender) revert SelfEscrow();
        uint256 count = amounts.length;
        if (count == 0 || count > MAX_MILESTONES || dueIn.length != count) revert BadMilestoneCount();

        key = escrowKey(escrowId, payee, amounts, dueIn);
        if (_escrows[key].client != address(0)) revert AlreadyFunded();

        uint64 now64 = uint64(block.timestamp);
        _escrows[key] = Escrow({client: msg.sender, payee: payee, fundedAt: now64, count: uint8(count)});
        uint256 total = _storeMilestones(key, amounts, dueIn, now64);

        _safeTransferFrom(msg.sender, address(this), total);
        emit EscrowFunded(key, escrowId, msg.sender, payee, total);
    }

    function _storeMilestones(bytes32 key, uint256[] calldata amounts, uint64[] calldata dueIn, uint64 now64)
        private
        returns (uint256 total)
    {
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = amounts[i];
            if (amount == 0) revert ZeroAmount();
            if (amount > type(uint128).max) revert AmountTooLarge();
            uint64 due = dueIn[i];
            if (due == 0 || due > MAX_DUE) revert BadDueDate();
            total += amount;

            Milestone storage m = _milestones[key][i];
            m.amount = uint128(amount);
            m.dueAt = now64 + due;
            m.status = Status.Locked;
        }
    }

    /// @dev A failed permit is ignored; the transfer decides the outcome.
    function _permit(uint256 total, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        try IERC20PermitEscrow(address(token)).permit(msg.sender, address(this), total, deadline, v, r, s) {} catch {}
    }

    function _release(bytes32 key, uint256 index, Escrow storage e, Milestone storage m) private {
        m.status = Status.Released;
        m.splitProposer = address(0);
        uint256 amount = m.amount;
        _safeTransfer(e.payee, amount);
        emit MilestoneReleased(key, index, e.payee, amount);
    }

    function _refund(bytes32 key, uint256 index, Escrow storage e, Milestone storage m) private {
        m.status = Status.Refunded;
        m.splitProposer = address(0);
        uint256 amount = m.amount;
        _safeTransfer(e.client, amount);
        emit MilestoneRefunded(key, index, e.client, amount);
    }

    function _escrow(bytes32 key) private view returns (Escrow storage e) {
        e = _escrows[key];
        if (e.client == address(0)) revert UnknownEscrow();
    }

    function _milestone(bytes32 key, Escrow storage e, uint256 index) private view returns (Milestone storage) {
        if (index >= e.count) revert BadIndex();
        return _milestones[key][index];
    }

    function _isOpen(Status s) private pure returns (bool) {
        return s == Status.Locked || s == Status.Delivered || s == Status.Disputed;
    }

    function _sum(uint256[] calldata amounts) private pure returns (uint256 total) {
        for (uint256 i; i < amounts.length; ++i) total += amounts[i];
    }

    /// @dev Accepts tokens that return true or nothing; rejects reverts and `false`.
    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(token).call(abi.encodeCall(IERC20Escrow.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20Escrow.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
