export type AgentName = "claude";

export interface AgentDef {
  image: string;
  entrypoint: string[];
}

export const agents: Record<AgentName, AgentDef> = {
  claude: {
    image: "pairpod/claude:latest",
    entrypoint: ["sleep", "infinity"],
  },
};

export function isAgentName(value: unknown): value is AgentName {
  return typeof value === "string" && value in agents;
}
