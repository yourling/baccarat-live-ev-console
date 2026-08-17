import { SqliteLedger } from '@baccarat/ledger-state';
import { Orchestrator } from '@baccarat/orchestrator';
import { SimulatedAdapter } from '@baccarat/adapter-contract';
import { FixtureBuilder } from '@baccarat/simulator-fixtures';
import { defaultProfile, defaultRiskLimits, type RiskLimits, type TableProfile, sha256, stableStringify } from '@baccarat/contracts';

async function main() {
  const ledger = new SqliteLedger();
  const riskLimits: RiskLimits = { ...defaultRiskLimits, defaultExposureCap: 100000, perTableLossLimit: 100000, perShoeLossLimit: 100000, perDayLossLimit: 1000000, maxConcurrentExecutions: 4, insufficientBehavior: 'skip' };
  const adapter = new SimulatedAdapter({ events: [] });
  const orch = new Orchestrator({ ledger, riskLimits, executor: adapter });
  const p: TableProfile = { ...defaultProfile('demo-table'), autoConfirmNewShoe: true, autoBetArmedByDefault: true, minEV: -10, limits: { minBet: 10, maxBet: 1000 } };
  orch.registerTable(p, 'simulated', 100);
  const events = new FixtureBuilder('demo-table')
    .newShoe('demo-shoe', p)
    .openWindow('demo-shoe', 'h1', 'bankerPair')
    .card('demo-shoe','h1',{rank:'A'},'player1')
    .card('demo-shoe','h1',{rank:'A'},'player2')
    .card('demo-shoe','h1',{rank:'Q'},'banker1')
    .card('demo-shoe','h1',{rank:'J'},'banker2')
    .closeWindow('demo-shoe','h1','bankerPair')
    .settle('demo-shoe','h1',[{rank:'A'},{rank:'A'}],[{rank:'Q'},{rank:'J'}], { bankerPair: true, playerPair: false })
    .redCard('demo-shoe','h2')
    .settle('demo-shoe','h2',[{rank:'K'},{rank:'Q'}],[{rank:'A'},{rank:'2'}], { bankerPair: false, playerPair: false })
    .build();
  for (const e of events) orch.enqueue('demo-table', e);
  await orch.getActor('demo-table')!.flush();
  const hash = sha256(stableStringify(ledger.listEvents()));
  console.log(`DEMO OK events=${ledger.listEvents().length} decisions=${ledger.listDecisions().length} receipts=${ledger.listReceipts().length} hash=${hash}`);
}

main().catch(err => { console.error(err); process.exit(1); });
