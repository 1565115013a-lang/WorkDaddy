const {spawnSync}=require('child_process');
const r=spawnSync('taskkill',['/F','/T','/IM','WorkBuddy.exe'],{encoding:'utf8',windowsHide:true,timeout:10000});
console.log('status:',r.status);
console.log('stdout:',(r.stdout||'').split(/\r?\n/).filter(Boolean).slice(-6).join('\n'));
