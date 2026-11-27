import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Own the Rust helper and the pending requests sent through its JSON line protocol. */
export function createCoreClient(binary, { env, getVault, isQuitting }) {
  let child = null;
  let nextId = 1;
  const pending = new Map();

  function start() {
    if (child) return;
    const helper = spawn(binary, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
    child = helper;
    helper.stderr.pipe(process.stderr, { end: false });
    const responses = createInterface({ input: helper.stdout, crlfDelay: Infinity });
    responses.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const request = pending.get(message?.id);
      if (!request || request.child !== helper) return;
      pending.delete(message.id);
      if ("err" in message) request.reject(message.err);
      else request.resolve(message.ok);
    });

    helper.once("exit", (code) => {
      if (child !== helper) return;
      child = null;
      responses.close();
      for (const [id, request] of pending) {
        if (request.child !== helper) continue;
        pending.delete(id);
        request.reject("NoteZ core stopped");
      }
      if (isQuitting()) return;
      console.error(`notez-core exited (${code}), restarting`);
      start();
      const vault = getVault();
      if (vault) void call("open_vault", { path: vault }).catch(() => {});
    });
  }

  function call(cmd, args) {
    start();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, child });
      child.stdin.write(JSON.stringify({ id, cmd, args: args ?? {} }) + "\n");
    });
  }

  return { call, start, stop: () => child?.kill() };
}
