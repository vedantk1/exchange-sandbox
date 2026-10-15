import { prepareSelfHost } from './acceptance/configuration.js';

try {
  const [origin, flag, directory, ...extra] = process.argv.slice(2);
  if (!origin || extra.length || (flag !== undefined && (flag !== '--directory' || !directory)))
    throw new Error('Invalid preparation arguments.');
  const configuration = await prepareSelfHost(origin, directory);
  console.log('Generated private self-host configuration. No default administrator was created.');
  console.log(
    `Use docker compose --env-file ${JSON.stringify(configuration.environmentFile)} for owner-controlled startup.`,
  );
} catch {
  console.error(
    'Self-host preparation failed. Supply an exact HTTPS origin and a fresh relative directory; existing configuration was preserved.',
  );
  process.exitCode = 1;
}
