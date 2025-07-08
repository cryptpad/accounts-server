/*@flow*/
/* jshint esversion: 6 */
module.exports = {
    // The address you want to bind to, :: means all ipv4 and ipv6 addresses
    // this may not work on all operating systems
    httpAddress: '::',
    httpPort: 3002,

    // Your Stripe account keys
    stripe: {
        privateKey: '',
        publicKey: '',
        webhookKey: ''
    },

    // Database config as a knex configuration object:
    // https://knexjs.org/guide/#configuration-options
    database: {
        client: 'sqlite3',
        connection: {
            filename: "./data/store.sqlite"
        },
        useNullAsDefault: true
    },

    // Time between each sync with Stripe, defaults to 20s
    periodicallyMs: 1000*20,

    // admins: public keys of users who should get admin rights
    // and be able to access all data
    admins: [
        ""
    ],

    // cryptpadOrigin: the instance connected to this accounts server
    cryptpadOrigin: 'https://cryptpad.fr',
};
