// How a piece of work starts, in a light project (Project.depth): core says in a few lines what it
// understood and what it would do (offer_start), and the human picks how to go on, from buttons
// above core's chat box: go ahead, brainstorm, a briefing or grilling. Nothing blocks on it: when
// the project lets core decide and nobody picks within START_OFFER_WAIT_MS, Symbio goes ahead,
// so a team left alone keeps working (the human can still pick something else later).

import { bus } from "../bus.js";
import type { Project, StartChoice } from "../store.js";
import { active, type TeamCore } from "./core.js";

export const START_OFFER_WAIT_MS = Number(process.env.SYMBIO_START_OFFER_SECONDS ?? 300) * 1000;
const CHECK_EVERY_MS = 5_000;

export const START_CHOICES: StartChoice[] = ["go", "brainstorm", "briefing", "grill"];

/** What core is told for each pick (the human's words come along when they wrote some). */
function instruction(choice: StartChoice, by: "human" | "symbio", decide: boolean): string {
  switch (choice) {
    case "go":
      if (by === "symbio") {
        return `Symbio: no answer to your offer in ${Math.round(START_OFFER_WAIT_MS / 60_000)} minutes, and the project lets you decide: go ahead as you proposed (plan and start). The human can still ask for something else.`;
      }
      return decide
        ? "The human chose: go ahead. Plan and start the work as you proposed; decide what's open yourself and record it in Needs you."
        : "The human chose: go ahead. Plan the work as you proposed and submit the plan now (submit_plan); it starts when they approve it.";
    case "brainstorm":
      return "The human chose: brainstorm. Talk it through with them here in the chat, informally: ideas, options, what matters to them, a few questions at a time. Start nothing yet; when it settles, offer again (offer_start).";
    case "briefing":
      return "The human chose: a briefing. Ask the questions that shape this work together, with start_briefing (your briefing skill has the method); its answers become the spec the work follows.";
    case "grill":
      return "The human chose: grilling. Question them in rounds until nothing about this work is open (your grilling skill has the method; each round one start_briefing); the answers become the spec the work follows.";
  }
}

export class StartOffers {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly team: TeamCore,
    private readonly now: () => number = Date.now,
  ) {}

  start() {
    this.timer ??= setInterval(() => void this.tick().catch((err) => console.error("[start-offer]", err.message)), CHECK_EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** core's offer_start: shows the choices to the human (and replaces an earlier offer). */
  async offer(project: Project, summary: string): Promise<string> {
    const text = summary.trim().slice(0, 2000);
    if (!text) throw new Error("Say in a few lines what you understood and what you'd do.");
    project.startOffer = { summary: text, at: this.now() };
    await this.team.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
    const wait = Math.round(START_OFFER_WAIT_MS / 60_000);
    return project.autonomy === "decide"
      ? `Shown to the human with the choices (go ahead, brainstorm, briefing, grilling). End your turn now. If nobody picks within ${wait} minutes, Symbio tells you to go ahead.`
      : "Shown to the human with the choices (go ahead, brainstorm, briefing, grilling). End your turn now and wait for their pick.";
  }

  /** The human picked (from the buttons), or Symbio went ahead for them. */
  async choose(project: Project, choice: StartChoice, by: "human" | "symbio" = "human"): Promise<void> {
    if (!START_CHOICES.includes(choice)) throw new Error(`Unknown choice "${choice}".`);
    const offer = project.startOffer;
    if (!offer) throw new Error("There's no offer to answer.");
    // core must be there to hear it; otherwise the offer stays, to be answered once it runs.
    const core = this.team.coordinator(project);
    if (!core || !active(core)) throw new Error("core is stopped: start it again (its chat), then pick.");
    const text = instruction(choice, by, project.autonomy === "decide");
    delete project.startOffer;
    await this.team.store.update(project);
    try {
      if (by === "symbio") await this.team.system(project, core, text);
      else await this.team.sendFromHuman(project, core, text);
    } catch (err) {
      // Not delivered: the offer comes back, so the pick can be made again.
      project.startOffer = offer;
      await this.team.store.update(project);
      throw err;
    } finally {
      bus.publish({ type: "project.updated", projectId: project.id });
    }
  }

  /** The human wrote to core instead of picking: their message decides, so the offer goes. */
  async answered(project: Project): Promise<void> {
    if (!project.startOffer) return;
    delete project.startOffer;
    await this.team.store.update(project);
    bus.publish({ type: "project.updated", projectId: project.id });
  }

  /** Goes ahead where nobody picked in time, in projects that let core decide. */
  async tick() {
    if (this.team.shuttingDown) return;
    for (const project of this.team.store.list()) {
      const offer = project.startOffer;
      if (!offer || project.autonomy !== "decide" || project.paused) continue;
      if (this.now() - offer.at < START_OFFER_WAIT_MS) continue;
      const core = this.team.coordinator(project);
      if (!core || !active(core)) continue; // nobody to tell: it waits until core runs again
      await this.choose(project, "go", "symbio").catch((err) => console.error(`[start-offer] ${project.name}: ${(err as Error).message}`));
    }
  }
}
