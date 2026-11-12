// Proxy for Pimlico's bundler + paymaster on Avalanche Fuji (Vercel Function).
// Keeps PIMLICO_API_KEY on the server and only allows the JSON-RPC methods
// the passkey wallet needs.
//
// Env vars:
//   PIMLICO_API_KEY                 required
//   PIMLICO_SPONSORSHIP_POLICY_ID   optional, limits sponsored gas (set in Pimlico dashboard)

const CHAIN_ID = 43113; // Avalanche Fuji

const ALLOWED = new Set([
  "eth_chainId",
  "eth_supportedEntryPoints",
  "eth_estimateUserOperationGas",
  "eth_sendUserOperation",
  "eth_getUserOperationReceipt",
  "eth_getUserOperationByHash",
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pimlico_getUserOperationGasPrice",
  "pimlico_getUserOperationStatus",
]);

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end(JSON.stringify(rpcError(null, -32600, "Method not allowed")));
  }

  const apiKey = process.env.PIMLICO_API_KEY;
  if (!apiKey) {
    console.error("bundler: PIMLICO_API_KEY is not set");
    res.statusCode = 503;
    return res.end(JSON.stringify(rpcError(null, -32000, "Bundler is not configured")));
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  const batch = Array.isArray(body) ? body : [body];
  if (!body || batch.length === 0 || batch.length > 10) {
    res.statusCode = 400;
    return res.end(JSON.stringify(rpcError(null, -32600, "Invalid request")));
  }

  for (const call of batch) {
    if (!call || typeof call.method !== "string" || !ALLOWED.has(call.method)) {
      res.statusCode = 403;
      return res.end(JSON.stringify(rpcError(call && call.id, -32601, `Method not allowed: ${call && call.method}`)));
    }
    // Attach the sponsorship policy to ERC-7677 paymaster calls: [userOp, entryPoint, chainId, context]
    const policy = process.env.PIMLICO_SPONSORSHIP_POLICY_ID;
    if (policy && call.method.startsWith("pm_") && Array.isArray(call.params)) {
      const context = (call.params[3] && typeof call.params[3] === "object") ? call.params[3] : {};
      call.params[3] = { ...context, sponsorshipPolicyId: policy };
    }
  }

  try {
    const base = process.env.PIMLICO_RPC_URL || `https://api.pimlico.io/v2/${CHAIN_ID}/rpc`; // override is for local tests
    const upstream = await fetch(`${base}?apikey=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    return res.end(text);
  } catch (err) {
    console.error("bundler:", err.message);
    res.statusCode = 502;
    return res.end(JSON.stringify(rpcError(batch[0] && batch[0].id, -32000, "Bundler is unreachable")));
  }
};
