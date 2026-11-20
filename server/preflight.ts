import 'dotenv/config';
import { runProductionPreflight } from './security/auth.ts';

const requireProd = process.argv.includes('--strict') || process.env.NODE_ENV === 'production';
const result = runProductionPreflight({ requireProductionNodeEnv: true });

// Never emit secret values; only boolean status and structured remediation messages
console.log(JSON.stringify(result, null, 2));

if (!result.ok && (requireProd || !process.argv.includes('--json-only'))) {
  process.exit(1);
}
