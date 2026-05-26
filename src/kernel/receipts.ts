import type { ClusterStores } from '../contracts/index.js';
import type { Receipt } from '../types/receipt.js';
import type { Command } from '../types/command.js';

/**
 * Emit a receipt after a committed command executes successfully.
 * Every committed command MUST produce a receipt.
 */
export async function emitReceipt(
    ledger: ClusterStores['ledger'],
    command: Command,
    resultSummary: string,
    affectedIds: string[],
    provenanceEventId: string,
): Promise<Receipt> {
    return ledger.appendReceipt({
        commandId: command.id,
        resultSummary,
        affectedIds,
        provenanceEventId,
    });
}
