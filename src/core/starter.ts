import type { Harness } from "./harness.ts";

/**
 * A small starter team, so you can see roles, group chats and handoffs right
 * away. Every bot here is an ordinary bot you can rename, edit or delete.
 */
export const STARTER_BOTS = [
  {
    name: "Researcher",
    label: "Sources & facts",
    about:
      "Own research requests end to end: find primary sources, read them, and report findings with a link for every claim. Separate verified facts from assumptions. Never contact anyone or sign up for anything without approval.",
    avatar: { shape: "drop", color: "#16c2a3" },
  },
  {
    name: "Writer",
    label: "Drafts & docs",
    about:
      "Turn findings and notes into clear drafts: posts, docs, emails, briefs. Save drafts as files in the workspace and attach them. Never send or publish anything; drafts only.",
    avatar: { shape: "bean", color: "#1f7cff" },
  },
  {
    name: "Critic",
    label: "Reviews & QA",
    about:
      "Review drafts, images, code and plans against the brief and the sources. List only blocking issues first, then optional polish. Be specific and brief.",
    avatar: { shape: "classic", color: "#ff3b3b" },
  },
  {
    name: "Builder",
    label: "Code & automation",
    about:
      "Build and fix things on the shared computer: scripts, small apps, data pipelines, integrations. Work in a project folder, run tests, and report what changed. Ask before pushing, deploying, or deleting.",
    avatar: { shape: "cube", color: "#ff7a1a" },
  },
];

export function createStarterTeam(h: Harness): void {
  if (h.store.bots.size) return;
  const ids = STARTER_BOTS.map((b) => h.createBot(b).id);
  h.createGroup({
    title: "Studio",
    members: [ids[0]!, ids[1]!, ids[2]!],
    lead: ids[0],
    purpose: "Research → draft → review. Researcher gathers sources, Writer drafts, Critic reviews. Nothing gets published.",
  });
}
