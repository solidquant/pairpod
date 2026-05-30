import { getDocker } from "./docker.js";
import { config } from "./config.js";

export async function ensurePairpodNetwork(): Promise<void> {
  const docker = getDocker();
  const networks = await docker.listNetworks();
  const exists = networks.some((n) => n.Name === config.pairpodNetwork);
  if (exists) return;
  await docker.createNetwork({ Name: config.pairpodNetwork, Driver: "bridge" });
}
