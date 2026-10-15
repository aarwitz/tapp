import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readProductProject } from "./product-operations.js";
import { BUSINESS_WORKFLOW_PATH, emptyBusinessWorkflows, normalizeBusinessWorkflows, discoverBusinessWorkflows, planBusinessWorkflow, businessWorkflowCoverage } from "./business-workflows.js";

function fileFor(projectDir) {
  const root=fs.realpathSync(projectDir || process.cwd());
  const directory=path.join(root,".tapp");
  if(fs.existsSync(directory) && !fs.realpathSync(directory).startsWith(root+path.sep))throw new Error("Workflow artifacts must remain inside the project");
  const file=path.join(root,BUSINESS_WORKFLOW_PATH);
  if(fs.existsSync(file) && !fs.realpathSync(file).startsWith(root+path.sep))throw new Error("Workflow map must remain inside the project");
  return file;
}
export function readBusinessWorkflowProject({projectDir=process.cwd(),connection={}}={}) {
  const file=fileFor(projectDir);
  const document=fs.existsSync(file)?normalizeBusinessWorkflows(JSON.parse(fs.readFileSync(file,"utf8"))):emptyBusinessWorkflows();
  const project=readProductProject({projectDir});
  return {document,inventory:discoverBusinessWorkflows(project,connection),
    plans:document.workflows.map(workflow=>planBusinessWorkflow(document,workflow.id,project,connection)),
    coverage:businessWorkflowCoverage(document,project,connection),
    note:"Local map inspection does not import hosted execution evidence. Continue using repository Flows, Scenarios and release gates for local execution."};
}
export function saveBusinessWorkflowProject({projectDir=process.cwd(),document,confirm=false}) {
  const file=fileFor(projectDir);
  const prior=fs.existsSync(file)?normalizeBusinessWorkflows(JSON.parse(fs.readFileSync(file,"utf8"))):emptyBusinessWorkflows();
  const next=normalizeBusinessWorkflows(document);
  if(next.revision!==prior.revision)throw new Error("Workflow map changed; read the current revision before saving");
  if(!confirm && next.workflows.some(workflow=>workflow.decision==="confirmed"))throw new Error("Use --confirm only after reviewing the listed outcomes and checks");
  next.revision++;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=`${file}.${randomUUID()}.tmp`;
  try {fs.writeFileSync(temporary,JSON.stringify(next,null,2)+"\n",{flag:"wx",mode:0o600});fs.renameSync(temporary,file);}
  finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return {path:file,document:next};
}
