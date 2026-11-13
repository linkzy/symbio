// The questions the team has for the human, kept in the project (.symbio/questions.json) instead
// of in the chat, where they scroll away. Each gets a number (Q1, Q2…), stays open until the human
// answers or sets it aside, and keeps its answer: the project's record of what the human decided.

import { promises as fs } from "node:fs";
import path from "node:path";
import { replaceFile } from "./fsutil.js";

export interface Question {
  id: string; // "Q12"
  question: string;
  /** What the human needs to know to answer: the situation, what was found, what each option means. */
  context?: string;
  /** Suggested answers to pick from (the human can still write their own). */
  options?: string[];
  taskId?: string;
  /** Work waits on the answer. */
  blocking: boolean;
  askedBy: string; // agent id
  askedAt: number;
  state: "open" | "answered" | "set-aside";
  answer?: string;
  /** "human" when answered in Symbio; "chat" when the asker recorded an answer given in the chat. */
  answeredIn?: "human" | "chat";
  /** Names of files the human attached to the answer. */
  files?: string[];
  closedAt?: number;
}

export interface QuestionInput {
  question: string;
  context?: string;
  options?: string[];
  taskId?: string;
  blocking?: boolean;
}

const MAX_TEXT = 4000;

export class QuestionStore {
  questions: Question[] = [];

  private constructor(private readonly file: string) {}

  static async load(projectDir: string): Promise<QuestionStore> {
    const store = new QuestionStore(path.join(projectDir, ".symbio", "questions.json"));
    try {
      store.questions = JSON.parse(await fs.readFile(store.file, "utf8"));
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    return store;
  }

  open(): Question[] {
    return this.questions.filter((q) => q.state === "open");
  }

  get(id: string): Question {
    const key = id.trim().toUpperCase().replace(/^(\d)/, "Q$1");
    const q = this.questions.find((x) => x.id === key);
    if (!q) throw new Error(`No question "${id}".`);
    return q;
  }

  /** An open question that asks the same thing, if any. */
  duplicateOf(question: string): Question | undefined {
    const words = keywords(question);
    if (words.size === 0) return undefined;
    return this.open().find((q) => {
      const other = keywords(q.question);
      const shared = [...words].filter((w) => other.has(w)).length;
      // Near-identical wording: most words in common, both ways.
      return shared / Math.max(words.size, other.size) >= 0.75;
    });
  }

  async ask(askedBy: string, input: QuestionInput): Promise<Question> {
    const question = input.question.trim();
    if (!question) throw new Error("Give the question.");
    const next = Math.max(0, ...this.questions.map((q) => Number(q.id.slice(1)) || 0)) + 1;
    const options = (input.options ?? []).map((o) => String(o).trim()).filter(Boolean).slice(0, 8);
    const q: Question = {
      id: `Q${next}`,
      question: question.slice(0, MAX_TEXT),
      ...(input.context?.trim() ? { context: input.context.trim().slice(0, MAX_TEXT) } : {}),
      ...(options.length ? { options } : {}),
      ...(input.taskId ? { taskId: input.taskId.trim().toUpperCase() } : {}),
      blocking: !!input.blocking,
      askedBy,
      askedAt: Date.now(),
      state: "open",
    };
    this.questions.push(q);
    await this.save();
    return q;
  }

  async close(id: string, how: { answer: string; answeredIn: "human" | "chat"; files?: string[] } | { setAside: true }): Promise<Question> {
    const q = this.get(id);
    if (q.state !== "open") throw new Error(`${q.id} was already ${q.state === "answered" ? "answered" : "set aside"}.`);
    if ("setAside" in how) q.state = "set-aside";
    else {
      if (!how.answer.trim()) throw new Error(`Give the answer to ${q.id}.`);
      q.state = "answered";
      q.answer = how.answer.trim().slice(0, MAX_TEXT);
      q.answeredIn = how.answeredIn;
      if (how.files?.length) q.files = how.files;
    }
    q.closedAt = Date.now();
    await this.save();
    return q;
  }

  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.questions, null, 2));
    await replaceFile(tmp, this.file);
  }
}

/** The words that carry meaning, without accents, case or punctuation (any language). */
function keywords(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFD")
      .replace(/\p{M}/gu, "") // accents, after NFD
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
}
