import { Exchange } from '../../apps/server/src/exchange.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const stage = process.env.EXCHANGE_CRASH_STAGE;
const serializedCommand = process.env.EXCHANGE_CRASH_COMMAND;
if (!databaseUrl || !serializedCommand || (stage !== 'beforeCommit' && stage !== 'afterCommit')) {
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
await exchange.placeLimit(command);
await exchange.close();
throw new Error('The worker passed its requested crash boundary without being killed.');
