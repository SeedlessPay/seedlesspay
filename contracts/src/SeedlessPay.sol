// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The ERC-20 functions SeedlessPay needs.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice EIP-2612 permit, supported by native USDC on Avalanche.
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// @title SeedlessPay
/// @notice Pays freelancer invoices in USDC. Funds move straight from the client to the
///         freelancer in one transfer; this contract never holds a balance.
/// @dev No owner, no upgrade path, no fees. An invoice is identified by the hash of its full
///      terms (id, payee, amount), so a third party cannot block a real invoice by paying the
///      same id with different terms first. Paying the same terms twice is rejected.
contract SeedlessPay {
    /// @notice The stablecoin invoices are paid in (USDC).
    IERC20 public immutable token;

    mapping(bytes32 key => bool) private _paid;

    event InvoicePaid(bytes32 indexed invoiceId, address indexed payer, address indexed payee, uint256 amount);

    error InvalidToken();
    error ZeroPayee();
    error ZeroAmount();
    error AlreadyPaid(bytes32 invoiceId);
    error TransferFailed();

    constructor(IERC20 token_) {
        if (address(token_).code.length == 0) revert InvalidToken();
        token = token_;
    }

    /// @notice Pays an invoice. The caller must have approved this contract for `amount`.
    function payInvoice(bytes32 invoiceId, address payee, uint256 amount) external {
        _pay(invoiceId, payee, amount);
    }

    /// @notice Approves and pays in one transaction using an EIP-2612 permit signed by the caller.
    /// @dev If someone submits the same permit first, the allowance is already in place, so a
    ///      failed permit is ignored and the transfer decides the outcome.
    function payInvoiceWithPermit(
        bytes32 invoiceId,
        address payee,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pay(invoiceId, payee, amount);
    }

    /// @notice Whether an invoice with exactly these terms has been paid.
    function isPaid(bytes32 invoiceId, address payee, uint256 amount) external view returns (bool) {
        return _paid[invoiceKey(invoiceId, payee, amount)];
    }

    /// @notice The storage key for an invoice's terms.
    function invoiceKey(bytes32 invoiceId, address payee, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encode(invoiceId, payee, amount));
    }

    function _pay(bytes32 invoiceId, address payee, uint256 amount) private {
        if (payee == address(0)) revert ZeroPayee();
        if (amount == 0) revert ZeroAmount();

        bytes32 key = invoiceKey(invoiceId, payee, amount);
        if (_paid[key]) revert AlreadyPaid(invoiceId);
        _paid[key] = true;

        _safeTransferFrom(msg.sender, payee, amount);

        emit InvoicePaid(invoiceId, msg.sender, payee, amount);
    }

    /// @dev Accepts tokens that return true or nothing; rejects reverts and `false`.
    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = address(token).call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
