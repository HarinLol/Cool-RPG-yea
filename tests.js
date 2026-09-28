'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(root,'public','game-data.json'),'utf8'));
const server = fs.readFileSync(path.join(root,'server.js'),'utf8');
const app = fs.readFileSync(path.join(root,'public','app.js'),'utf8');

function assert(ok,msg){if(!ok)throw new Error(msg)}
assert(Object.keys(data.normalEnemies).length === 18,'Expected 18 normal enemies.');
assert(data.normalEnemies['12'].name === 'Primer World Eater','Enemy data mismatch.');
assert(data.weapons['Hammer'].damage === 110,'Hammer damage mismatch.');
assert(data.weapons['Portal gun'].damage === 1200,'Portal gun damage mismatch.');
assert(data.classes.Warrior && data.classes.Mage && data.classes.Medic,'Missing classes.');
assert(data.armor['Titan Armor'],'Missing armor.');
assert(server.includes("if (mode === 'pvp' && players.length !== 2)"),'PvP player-count guard missing.');
assert(server.includes('players.size >= 3'),'3-player room limit missing.');
assert(server.includes("action === 'sync_profile'"),'Profile sync missing.');
assert(server.includes("action === 'trade_offer'"),'Trade action missing.');
assert(server.includes('turnPlayer(room)'),'Turn validation missing.');
assert(app.includes("removeEndlessPopups") && app.includes("shakeMode") && app.includes("removeAllPopups"),'Settings missing.');
assert(app.includes("/api/state") && app.includes("/api/action"),'API integration missing.');
assert(server.includes('baseMaxHp: p.maxHp') && server.includes('baseDamage: p.damage'),'Base-stat fields missing; repeated sync could compound class bonuses.');

const child = cp.spawnSync(process.execPath,['--check',path.join(root,'server.js')],{encoding:'utf8'});
assert(child.status===0,child.stderr||'server.js syntax error');
console.log('CoolRPG Web tests: PASS');
console.log('Server syntax: PASS');
console.log('Data checks: PASS');
