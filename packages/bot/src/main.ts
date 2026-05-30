import { ensureHome } from "./paths.js";
import { loadEnv } from "./env.js";

ensureHome();
loadEnv();

// Import the server only after env is loaded, so config reads the final values.
const { startServer } = await import("./server.js");
await startServer();
