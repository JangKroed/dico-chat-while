// Composer clearance is submission evidence, not a Discord server message ID.
// Only a fresh, actually submitted, scoped draft can create this receipt.
export function composerClearedEvidence(e){
 return Boolean(e&&e.phase==='commit'&&e.stage==='observe'&&e.enterAttempted===true&&e.expectedDraftSubmitted===true&&e.composerCleared===true&&e.sameEditor===true&&e.targetMatched===true&&e.accountMatched===true&&e.failedSeen===false&&e.composerRetained!==true&&['keyboard','button'].includes(e.submitMethod)&&Number.isSafeInteger(e.emptyStableMs)&&e.emptyStableMs>=500&&e.emptyStableMs<=30000);
}
