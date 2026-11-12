// The team's questions for the human: numbering, refusing what's already open, closing, and the file.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { QuestionStore } from "../src/server/questions.js";

test("questions are numbered, kept in the project, and closed once", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sym-q-"));
  const store = await QuestionStore.load(dir);
  const q1 = await store.ask("core", { question: "Should a blank field in the generated form warn or block?", options: ["Warn", "Block", " "], taskId: "t3", blocking: true });
  const q2 = await store.ask("helper", { question: "Which city goes at the end of the letter?", context: "The **local** or the campus." });
  assert.equal(q1.id, "Q1");
  assert.equal(q2.id, "Q2");
  assert.deepEqual(q1.options, ["Warn", "Block"], "empty options dropped");
  assert.equal(q1.taskId, "T3");

  await store.close("q1", { answer: "Warn only", answeredIn: "human" });
  await assert.rejects(store.close("Q1", { setAside: true }), /already answered/);
  await assert.rejects(store.close("Q2", { answer: "  ", answeredIn: "human" }), /Give the answer/);
  await store.close("2", { setAside: true });
  assert.deepEqual(store.open(), []);

  const again = await QuestionStore.load(dir);
  assert.deepEqual(
    again.questions.map((q) => [q.id, q.state, q.answer]),
    [
      ["Q1", "answered", "Warn only"],
      ["Q2", "set-aside", undefined],
    ],
  );
  assert.ok(readFileSync(path.join(dir, ".symbio", "questions.json"), "utf8").includes("Warn only"));
  assert.equal((await again.ask("core", { question: "Something new entirely?" })).id, "Q3", "numbers keep counting");
});

test("asking what's already open is spotted, whatever the case, accents or punctuation", async () => {
  const store = await QuestionStore.load(mkdtempSync(path.join(os.tmpdir(), "sym-q-")));
  await store.ask("core", { question: "No TCE gerado, o Plano de Atividades em branco deve só avisar, impedir ou ficar livre?" });
  assert.equal(store.duplicateOf("no tce gerado: o plano de atividades em branco deve so avisar, impedir ou ficar livre")?.id, "Q1");
  assert.equal(store.duplicateOf("No TCE gerado, o Plano de Atividades em branco deve avisar ou impedir?")?.id, "Q1", "a shorter rewording");
  assert.equal(store.duplicateOf("Qual cidade vai no fim do ofício de distância?"), undefined, "a different question");
  await store.close("Q1", { answer: "Avisar", answeredIn: "chat" });
  assert.equal(store.duplicateOf("No TCE gerado, o Plano de Atividades em branco deve só avisar, impedir ou ficar livre?"), undefined, "closed questions can be asked again");
});
