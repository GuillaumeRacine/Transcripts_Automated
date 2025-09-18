import fs from 'fs';
import dotenv from 'dotenv';

// Always prefer .env.local for secrets; fall back to .env only if needed.
const localPath = '.env.local';
const defaultPath = '.env';

if (fs.existsSync(localPath)) {
  dotenv.config({ path: localPath });
} else if (fs.existsSync(defaultPath)) {
  dotenv.config({ path: defaultPath });
}
