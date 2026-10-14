import { Exchange } from '../../apps/server/src/exchange.js';
import { AdminService } from '../../apps/server/src/admin/index.js';
import type { AdminCommand } from '../../apps/server/src/admin/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const stage = process.env.EXCHANGE_CRASH_STAGE;
const serializedCommand = process.env.EXCHANGE_CRASH_COMMAND;
if (
  !databaseUrl ||
  !serializedCommand ||
  !stage ||
  ![
    'beforeCommit',
    'afterCommit',
    'afterRolloverGate',
    'beforeRolloverCommit',
    'afterRolloverCommit',
  ].includes(stage)
) {
  throw new Error('The crash worker requires a database, command, and valid crash stage.');
}
const command = JSON.parse(serializedCommand) as Parameters<Exchange['placeLimit']>[0];
const exchange = await Exchange.open(databaseUrl, {
  hooks: {
    [stage]: async (commandId: string) => {
      if (commandId !== command.commandId) return;
      if (!process.send) throw new Error('The crash worker requires an IPC channel.');
      process.send({ stage });
      // The parent kills this process at a known transaction boundary. Throwing
      // here would only test orderly rollback and would miss real process loss.
      await new Promise<void>(() => undefined);
    },
  },
});
if (process.env.EXCHANGE_CRASH_OPERATION === 'rollover') {
  const token = process.env.EXCHANGE_CRASH_TOKEN;
  if (!token) throw new Error('A rollover crash worker requires its authenticated test session.');
  await new AdminService(exchange).rollover(token, JSON.parse(serializedCommand) as AdminCommand);
} else if (process.env.EXCHANGE_CRASH_OPERATION === 'market') {
  await exchange.placeMarket(
    JSON.parse(serializedCommand) as Parameters<Exchange['placeMarket']>[0],
  );
} else {
  await exchange.placeLimit(command);
}
await exchange.close();
throw new Error('The worker passed its requested crash boundary without being killed.');
