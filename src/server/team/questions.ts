// The team's open questions for the human (questions.ts keeps them). Agents ask with ask_human;
// the human answers from Needs you, several at once, and each asker gets its answers in one message
// (a helper's go to the helper, and core is told). Asking what's already open is refused, so the
// same question doesn't come back again and again.

import { bus } from "../bus.js";
import { attachmentNote, getAttachments, markSent, type Attachment } from "../attachments.js";
import { QuestionStore, type Question, type QuestionInput } from "../questions.js";
import type { Agent, Project } from "../store.js";
import { active, type TeamCore } from "./core.js";

export class Questions {
  private stores = new Map<string, Promise<QuestionStore>>();

  constructor(private readonly team: TeamCore) {}

  store(project: Project): Promise<QuestionStore> {
    let store = this.stores.get(project.id);
    if (!store) {
      store = QuestionStore.load(project.directory);
      this.stores.set(project.id, store);
    }
    return store;
  }

  forget(projectId: string) {
    this.stores.delete(projectId);
  }

  async ask(project: Project, agent: Agent, input: QuestionInput): Promise<string> {
    const store = await this.store(project);
    const same = store.duplicateOf(input.question);
    if (same) {
      return (
        `Already open as ${same.id} (asked ${same.askedBy === agent.id ? "by you" : `by ${this.team.agentName(project, same.askedBy) ?? "another agent"}`}): "${same.question}". ` +
        "Don't ask it again; the answer arrives as a message. If it has changed, close it with close_question and ask the new one."
      );
    }
    if (input.taskId) (await this.team.plan(project)).task(input.taskId); // a wrong task id fails here
    const q = await store.ask(agent.id, input);
    await this.team.log(project, { from: agent.id, to: "human", kind: "question", text: `${q.id}: ${q.question}` });
    this.changed(project);
    return (
      `Recorded as ${q.id} in the human's open questions (Needs you), with its context${q.options ? " and options" : ""}. ` +
      "Their answer arrives as a message. Don't repeat it or list open questions in the chat: Symbio shows them. " +
      (q.blocking ? "Meanwhile, continue with work that doesn't depend on it, or end your turn." : "Continue meanwhile.")
    );
  }

  /** The human's answers, several at once (each may bring files): one message per agent that asked. */
  async answer(project: Project, answers: { id: string; answer: string; attachments?: string[] }[]): Promise<Question[]> {
    const store = await this.store(project);
    const given = answers.filter((a) => a.answer?.trim() || a.attachments?.length);
    if (given.length === 0) throw new Error("Write at least one answer.");
    for (const a of given) if (store.get(a.id).state !== "open") throw new Error(`${store.get(a.id).id} is no longer open.`);
    // Check every file before closing anything, so a missing one doesn't leave answers half sent.
    const filesOf = new Map<string, Attachment[]>();
    for (const a of given) filesOf.set(a.id, a.attachments?.length ? await getAttachments(project, a.attachments) : []);
    const closed: Question[] = [];
    for (const a of given) {
      const files = filesOf.get(a.id)!;
      const answer = a.answer?.trim() || (files.length === 1 ? "(see the attached file)" : "(see the attached files)");
      closed.push(await store.close(a.id, { answer, answeredIn: "human", files: files.map((f) => f.name) }));
    }
    this.changed(project);

    const byAsker = new Map<string, Question[]>();
    for (const q of closed) byAsker.set(q.askedBy, [...(byAsker.get(q.askedBy) ?? []), q]);
    const core = this.team.coordinator(project);
    for (const [askerId, qs] of byAsker) {
      const asker = project.agents.find((x) => x.id === askerId);
      const list = qs.map((q) => `${q.id}: ${q.question}\n→ ${q.answer}${q.files?.length ? ` (attached: ${q.files.join(", ")})` : ""}`).join("\n\n");
      const files = qs.flatMap((q) => filesOf.get(q.id) ?? []);
      if (asker && active(asker)) {
        await this.team.sendFromHuman(project, asker, `My answer${qs.length > 1 ? "s" : ""} to your question${qs.length > 1 ? "s" : ""}:\n\n${list}` + attachmentNote(files));
        if (files.length) await markSent(project, files.map((f) => f.id), asker.id);
        if (asker.role === "worker" && core && active(core)) {
          await this.team.system(project, core, `Symbio: the human answered ${asker.name}'s question${qs.length > 1 ? "s" : ""} (it has the answer):\n\n${list}`, false);
        }
      } else if (core && active(core)) {
        await this.team.system(project, core, `Symbio: the human answered question${qs.length > 1 ? "s" : ""} asked by ${this.team.agentName(project, askerId) ?? "a helper"}, who is no longer active:\n\n${list}`);
      }
    }
    return closed;
  }

  /** The human doesn't want to answer it (no longer relevant, or decided elsewhere). */
  async setAside(project: Project, id: string, note?: string): Promise<Question> {
    const store = await this.store(project);
    const q = await store.close(id, { setAside: true });
    this.changed(project);
    const asker = project.agents.find((x) => x.id === q.askedBy);
    const target = asker && active(asker) ? asker : this.team.coordinator(project);
    if (target && active(target)) {
      await this.team.system(
        project,
        target,
        `Symbio: the human set aside ${q.id} ("${q.question}")${note?.trim() ? ` with this note: ${note.trim()}` : ", without an answer"}. Don't ask it again; go on without it, or ask them in a different way if the work really needs it.`,
        q.blocking,
      );
    }
    return q;
  }

  /** An agent closes its own question (or core any): answered in the chat, or no longer needed. */
  async closeByAgent(project: Project, agent: Agent, id: string, answer?: string): Promise<string> {
    const store = await this.store(project);
    const q = store.get(id);
    if (agent.role !== "coordinator" && q.askedBy !== agent.id) throw new Error(`${q.id} was asked by someone else; only they or the coordinator can close it.`);
    await store.close(q.id, answer?.trim() ? { answer, answeredIn: "chat" } : { setAside: true });
    this.changed(project);
    return answer?.trim() ? `${q.id} closed with the answer the human gave in the chat.` : `${q.id} closed: no longer needed.`;
  }

  async describe(project: Project): Promise<string> {
    const store = await this.store(project);
    const open = store.open();
    const recent = store.questions.filter((q) => q.state !== "open").slice(-10);
    const who = (id: string) => this.team.agentName(project, id) ?? "?";
    const lines = [
      open.length ? "Open (waiting for the human):" : "No open questions.",
      ...open.map((q) => `- ${q.id}${q.blocking ? " [blocking]" : ""}${q.taskId ? ` (${q.taskId})` : ""} by ${who(q.askedBy)}: ${q.question}`),
    ];
    if (recent.length) {
      lines.push("", "Recently closed:");
      for (const q of recent) lines.push(`- ${q.id}: ${q.question} → ${q.state === "answered" ? q.answer : "set aside"}`);
    }
    return lines.join("\n");
  }

  private changed(project: Project) {
    bus.publish({ type: "questions.updated", projectId: project.id });
  }
}
