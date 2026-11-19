import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main as cloudSmoke, parseArgs } from './smoke-cloud.mjs';

export function parseTestingArgs(argv) {
  const options=parseArgs(['--stack','saldoevento-test',...argv]);
  if(options.stack !== 'saldoevento-test') throw Object.assign(new Error('Only saldoevento-test is permitted.'),{code:'TESTING_STACK_REQUIRED'});
  return options;
}

export async function runTestingSmoke(argv,runner=cloudSmoke) {
  const options=parseTestingArgs(argv);
  return runner(['--stack',options.stack,'--region',options.region]);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode=await runTestingSmoke(process.argv.slice(2)); }
  catch(error) { console.error(JSON.stringify({status:'failed',code:error.code ?? 'TESTING_SMOKE_SETUP_FAILED'}));process.exitCode=1; }
}
