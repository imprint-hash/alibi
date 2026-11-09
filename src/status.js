#!/usr/bin/env node
// Prints which keys are set (never values) and the usage counters.
import { envStatus } from './env.js';
import { callCounts } from './sui.js';
import { spend } from './ai.js';
import { writesSoFar, walrusReady } from './memory.js';
import { readJson, path } from './store.js';

const keys = ['TATUM_API_KEY', 'TATUM_ACCOUNT_ID', 'MEMWAL_ACCOUNT_ID', 'MEMWAL_KEY', 'MEMWAL_AGENT_ID', 'MEMWAL_OWNER', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'SUI_PRIVATE_KEY', 'SUI_ADDRESS', 'PYTH_API_KEY'];
console.log(JSON.stringify({ env: envStatus(keys), walrus: await walrusReady(), memoryWrites: writesSoFar(), tatum: callCounts(), pyth: readJson(path('results', 'pyth-calls.json'), {}), spend: spend() }, null, 2));
