// The chat's plain-word labels for the team's steps, on commands and scripts seen in real projects.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callsFromCode, commandLabel, stepLabels, summarize } from "../web/src/steps.js";

const label = (command: string) => commandLabel(command).label;

test("shell commands read as what they do", () => {
  assert.equal(label("git merge symbio/modulo-professor --no-edit 2>&1 | Select -Last 1; git diff --name-only --diff-filter=U"), "Merged symbio/modulo-professor · Compared changes");
  assert.equal(label("Start-Sleep 20; Test-NetConnection localhost -Port 7343 -InformationLevel Quiet -WarningAction SilentlyContinue"), "Waited for the app on port 7343");
  assert.equal(label('$rc="$env:TEMP\\opencode\\run-core"; Remove-Item "$rc\\rev-S.ctl" -ErrorAction SilentlyContinue'), "Deleted rev-S.ctl");
  assert.equal(label('Start-Sleep 50; Get-Content "$env:TEMP\\opencode\\run-core\\publicar.log" | Select-String "Erro|True" | % { $_.Line.Trim() }'), "Waited 50s · Read publicar.log");
  assert.equal(label('git diff --stat "origin/main..main" | Select -Last 1; git grep -l "^<<<<<<<" -- .'), 'Compared changes · Searched the repository for "^<<<<<<<"');
  assert.equal(label("dotnet test tests/Estagio.Tests && dotnet build"), "Ran the tests · Built the project");
  assert.equal(label("npm run build"), "Built the project");
  assert.equal(label("cd web; npm install"), "Installed dependencies");
  assert.equal(label("curl -s http://localhost:5173/api/health"), "Called localhost:5173/api/health");
  assert.equal(label("some-tool --flag"), "Ran some-tool");
  assert.equal(label('node -e "setTimeout(()=>{},300)"'), "Ran a script");
  assert.equal(label("python scripts/seed.py --fast"), "Ran seed.py");
  assert.equal(commandLabel("").label, "Ran a command");
});

test("Symbio's tools, alone or called from a code-mode script, read from their arguments", () => {
  // OpenCode's code mode: one step, several tools, listed in metadata.toolCalls.
  const calls = [
    { tool: "symbio.send_message", status: "completed", input: { to: "padrao-visual", message: "Desculpe a demora: a sua entrega da T213…\nMore" } },
    { tool: "symbio.assign_task", status: "completed", input: { task_id: "t215", agent: "modulo-coordenador", note: "git merge main" } },
    { tool: "symbio.merge_work", status: "completed", input: { agent: "setor" } },
  ];
  const labels = stepLabels("execute", { code: "const r=[]; …" }, calls);
  assert.deepEqual(
    labels.map((l) => l.label),
    ["Message to padrao-visual", "Gave T215 to modulo-coordenador", "Merged setor's work"],
  );
  assert.equal(labels[0].detail, "Desculpe a demora: a sua entrega da T213…");

  // While the step still runs there's no metadata: the calls come from the code itself.
  const code = 'r.push(await tools.symbio.update_task({task_id:"T12",status:"done"}));\nawait tools.symbio.ask_human({question:"Warn or block?", blocking:true})';
  assert.deepEqual(callsFromCode(code).map((c) => c.tool), ["symbio.update_task", "symbio.ask_human"]);
  assert.deepEqual(stepLabels("execute", { code }).map((l) => l.label), ["Marked T12 done", "Added a question for you"]);

  assert.equal(stepLabels("read", { path: "C:\\Users\\x\\docs\\padrao-visual\\padrao.md", offset: 252 })[0].label, "Read padrao.md");
  assert.equal(stepLabels("grep", { pattern: "^\\| (SA-015|CG-011)", path: "docs/regras" })[0].label, 'Searched for "^\\| (SA-015|CG-011)"');
  assert.equal(stepLabels("edit", { filePath: "src/Foo.cs" })[0].label, "Edited Foo.cs");
  assert.equal(stepLabels("symbio_update_task", { task_id: "T3", status: "review" })[0].label, "Reported T3 for review");
  assert.equal(stepLabels("mystery_tool", {})[0].label, "mystery tool");
});

test("a run of steps is summed up by what matters most", () => {
  const run = [
    ...stepLabels("read", { path: "a.md" }),
    ...stepLabels("shell", { command: "git merge symbio/setor --no-edit" }),
    ...stepLabels("shell", { command: "Start-Sleep 20; Test-NetConnection localhost -Port 7343" }),
    ...stepLabels("execute", {}, [{ tool: "symbio.send_message", input: { to: "setor", message: "ok" } }]),
    ...stepLabels("read", { path: "a.md" }),
  ];
  assert.equal(summarize(run), "Merged symbio/setor · Message to setor and 2 more");
  assert.equal(summarize(stepLabels("read", { path: "a.md" })), "Read a.md");
  assert.equal(summarize([]), "");
});
