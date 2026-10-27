// Runs the API server (watch mode) and the Vite dev server together.
import { spawn } from "node:child_process";

const procs = [
  spawn("npm", ["run", "dev:server"], { stdio: "inherit", shell: true, env: { ...process.env, SYMBIO_NO_OPEN: "1" } }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit", shell: true }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", stop);
