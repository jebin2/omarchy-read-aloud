// Loads, then dies on the first request (like an OOM kill mid-read).
process.send!({ type: "ready", loadMs: 1 });
process.on("message", () => process.exit(3));
