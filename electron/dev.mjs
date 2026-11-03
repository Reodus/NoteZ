// `npm run dev`: Vite dev server + Electron pointed at it.
import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, NOTEZ_DEV_URL: url } });
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
