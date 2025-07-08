/* jshint esversion: 6 */

const fs = require('node:fs');
const config = require('../config/config');
const knex = require('knex')(config.database);

(() => {
var plan = false;
if (process.argv.indexOf('--plan') > -1) { plan = true; }
if (plan) {
    knex.select('*').from('plan').then(function (arr) {
        console.log(JSON.stringify(arr, null, 2));
    }).catch((e) => { console.log(e); });
    return;
}

var quaderno = false;
if (process.argv.indexOf('--quaderno') > -1) { quaderno = true; }
if (quaderno) {
    knex.select('*').from('quaderno').then(function (arr) {
        console.log(JSON.stringify(arr, null, 2));
    }).catch((e) => { console.log(e); });
    return;
}

if (process.argv.indexOf('--update') > -1) {
    knex.select('*').from('update').then(function (arr) {
        console.log(JSON.stringify(arr, null, 2));
    }).catch((e) => { console.log(e); });
    return;
}

if (process.argv.indexOf('--dpa') > -1) {
    knex.select('*').from('dpa').then(function (arr) {
        console.log(JSON.stringify(arr, null, 2));
    }).catch((e) => { console.log(e); });
    return;
}

if (process.argv.indexOf('--stripe') > -1) {
    knex.select('*').from('stripe').then(function (arr) {
        console.log(JSON.stringify(arr, null, 2));
    }).catch((e) => { console.log(e); });
    return;
}

knex.select('*').from('subscription').then(function (arr) {
    console.log(JSON.stringify(arr, null, 2));
});
})();
