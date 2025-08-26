/*@flow*/
/* jshint esversion: 8 */
const Express = require('express');
const config = require('./config/config');
const Knex = require('knex');
const AuthCommands = require('./lib/http-commands');
const Dns = require('dns');
const Stripe = require('stripe');
const nThen = require('nthen');
const cors = require('cors');
const Axios = require('axios');
const multer = require('multer'); // Process formdata: upload DPA
const Plans = require('./config/plans');
const { getBasePlan, parseUser, ENABLED_STATUS, mkRandomCookie,
        now, log, error } = require('./lib/utils');

const commands = require('./lib/commands');
AuthCommands.setCommands(commands);


const getPlanFromPrice = price => {
    let isYearly = '';
    const planId = Object.keys(Plans).find(id => {
        if (Plans[id].id === price) { return true; }
        if (Plans[id].id_yearly === price) {
            isYearly = '12';
            return true;
        }
    });
    return planId ? `${planId}${isYearly}` : price;
};

const forceCryptPadUpdate = () => {
    const origin = config.cryptpadOrigin;
    if (!origin) { return; }
    Axios.get(origin + '/api/updatequota').then(() => {
        log(['INFO', 'forceQuotaUpdate', 'success']);
    }).catch((err) => {
        //console.error(err);
        error(["EUPDATE", "Can't update quota on CryptPad instance", err.status]);
    });
};





/** cancelSubscription
 * - called when we want to subscribe to a new plan but we already
 *   have an active one
 */
const cancelSubscription = (ctx, sub, cb) => {
    const cancelDB = function (time) {
        ctx.knex('subscription').where({ id: sub.id }).update({
            end_time: time
        }).asCallback((e) => {
            if (e) {
                return void cb(e);
            } else {
                ctx.mut.lastCycle = 0;
                cb();
            }
        });
    };

    if (sub.plan_added || sub.admin_added) {
        return void cancelDB(+new Date());
    }

    ctx.stripe.subscriptions.update(sub.transaction,
             { cancel_at_period_end: true },
             (err, confirmation) =>
    {
        if (err) {
            return void cb(err);
        }
        cancelDB(confirmation.current_period_end * 1000);
    });
};
/** onStripe
 * - called when a plan was updated/canceled from Stripe
     (portal or admin)
 */
const onStripeUpdate = (ctx, id, cb) => {
    ctx.knex('subscription').where({ transaction: id })
       .update({last_checked_stripe: 0}).asCallback((e) => {
        if (e) {
            return void cb(e);
        }
        ctx.mut.lastCycle = 0;
        cb();
    });
};
const subscribe = (ctx, data, cb) => {
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (ctx.domain !== data.benificiary_domain) {
        return void onError('NOT_ACCOUNTS_READY', 'subscribe');
    }

    nThen((waitFor) => {
        if (data.plan) { return; }
        if (!data.sub_id) {
            waitFor.abort();
            return void onError('MISSING_DATA', 'subscribe');
        }
        ctx.stripe.subscriptions.retrieve(data.sub_id,
                 waitFor((err, sub) =>
        {
            if (err) {
                return void onError('INVALID_SUB', 'subscribe', err);
            }
            let items = sub.items.data;
            if (!Array.isArray(items) || !items.length) {
                return void onError('INVALID_SUB_ITEMS', 'subscribe');
            }
            const price = items[0].price.id;
            data.plan = getPlanFromPrice(price);
        }));
    }).nThen((waitFor) => {
        var w = waitFor();
        // Cancel existing active subscriptions
        ctx.knex('subscription').whereIn('status', ENABLED_STATUS).andWhere({
            benificiary_domain: data.benificiary_domain,
            benificiary_pubkey: data.benificiary_pubkey,
        }).then((arr) => {
            if (arr.length) {
                // This user already uses an active subscription, cancel it
                arr.forEach(function (sub) {
                    console.log(sub);
                    cancelSubscription(ctx, sub, waitFor((err) => {
                        if (!err) { return; }
                        error(['EDBCHECK',
                            "Can't cancel existing subscription",
                            sub.id,
                            new Date()
                        ]);
                    }));
                });
            }
            w();
        }).catch((err) => {
            w();
            error(['EDBCHECK',
                "Can't cancel existing subscriptions",
                err, new Date()
            ]);
        });
    }).nThen(() => {
        const toInsert = {
            customer: data.jwt.customer,
            transaction: data.jwt.transaction,
            iat: data.jwt.iat,
            domain: data.domain,
            jwt_msg: '',
            pubkey: data.pubkey,
            benificiary_domain: data.benificiary_domain,
            benificiary_pubkey: data.benificiary_pubkey,
            benificiary_user: data.benificiary_user,
            gift_note: data.gift_note || '',
            admin_added: data.admin_added || 0,
            plan_added: 0,
            plan: data.plan,
            last_checked_stripe: 0,
            status: data.status,
            create_time: now(),
            end_time: data.end_time
        };
        ctx.knex('subscription').insert(toInsert).then((arr) => {
            log(['INFO', 'subscribe', 'insert', data, arr[0]]);
            ctx.mut.lastCycle = 0;
            cb(void 0, { id: arr[0] });
            forceCryptPadUpdate();
        }).catch((e) => {
            onError('EDBPUT', 'subscribe', e);
        });
    });
};

const onStripeWebhook = (ctx, req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = config.stripe && config.stripe.webhookKey;
    if (!endpointSecret) {
        return void res.status(400).send(`Webhook Error: missing secret key`);
    }

    let event;

    try {
        event = ctx.stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.log(err);
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }

    const onError = (...args) => {
        error(args);
        res.status(500).send({
            message: args[0],
            location: args[1]
        });
    };


    if (event.type === 'checkout.session.completed') {
        // We use a token (random string) stored in our DB to link
        // a Stripe session with a user pubkey without sending
        // that pbukey to Stripe
        // In case of a database error when creating a token,
        // we directly send the domain and pubkey as metadata
        // to Stripe
        let token = event?.data?.object?.client_reference_id || {};
        let metadata = event?.data?.object?.metadata || {};
        let domain = metadata.domain;
        let pubkey = metadata.key;
        let user = metadata.user;
        nThen(function (waitFor) {
            if (!token) { return; }
            ctx.knex('stripe').where({token: token}).select().then(waitFor((arr) => {
                if (arr.length !== 1) {
                    waitFor.abort();
                    return onError('ENOENT', 'webhook_token');
                }
                let obj = arr[0];
                domain = obj.domain;
                pubkey = obj.pubkey;
            })).catch((e) => {
                waitFor.abort();
                onError('EDBGET', 'webhook_token', e);
            });
        }).nThen(function () {
            if (!domain || !pubkey) {
                return onError('EINVAL', 'webhook_subscribe_domain');
            }
            subscribe(ctx, {
                domain: domain,
                pubkey: pubkey,
                benificiary_domain: domain,
                benificiary_pubkey: pubkey,
                benificiary_user: user,
                status: 'active',
                jwt: {
                    customer: event.data.object.customer,
                    iat: event.created,
                    transaction: event.data.object.subscription
                },
                sub_id: event.data.object.subscription
            }, (err, data) => {
                if (err) {
                    return onError('EINVAL', 'webhook_subscribe', err);
                }
                res.send(data);
                ctx.knex('stripe').where({token: token}).update({
                    sub_time: now()
                }).then(() => {
                }).catch((e) => {
                    console.error(e);
                });
            });
        });
        return;
    } else if (event.type === 'checkout.session.async_payment_failed') { // SEPA fail
    } else if (event.type === 'checkout.session.async_payment_succeeded') { // SEPA success
    } else if (event.type === 'customer.subscription.updated') { // UPGRADE/DOWNGRADE
        return void onStripeUpdate(ctx, event.data.object.id, err => {
            if (err) {
                return onError('EDBUPDATE', 'webhookupdate', err);
            }
            res.send({});
        });
    } else if (event.type === 'customer.subscription.deleted') { // CANCEL
        return void onStripeUpdate(ctx, event.data.object.id, err => {
            if (err) {
                return onError('EDBCANCEL', 'webhookcancel', err);
            }
            res.send({});
        });
    } else if (event.type === 'customer.updated') { // email address
    } else {
        //console.log(`Unhandled event type ${event.type}`);
    }
    res.send();
};

const latestVersion = '2025.6.0';
const latestVersionURL = 'https://github.com/cryptpad/cryptpad/releases/' + latestVersion;
const respondWithUpdateAvailable = function (req, res) {
    const k = mkRandomCookie();
    const location = 'getauthorized';
    const type = 'EINVAL';
    const body = {
        message: type,
        location: location,
        k: k,
        version: latestVersion,
        updateAvailable: latestVersionURL,
    };
    //log(['ERR', k, location, type, '', req.body]);
    res.send(body);
};

const getAuthorized = (ctx, req, res) => {
    const domain = req.body.domain;
    const subdomain = req.body.subdomain || domain;

    if ((config?.ignoredDomains || []).includes(domain)) { return; }

    log(["DEBUG", "getauthorized", req.headers['x-real-ip'], req.body]);

    return respondWithUpdateAvailable(req, res);
};


const getQuota = (ctx, req, res) => {
    const domain = req.body.domain;
    const subdomain = req.body.subdomain || domain;

    const onError = (...args) => {
        error(args);
        res.status(500).send({
            message: args[0],
            location: args[1]
        });
    };

    if (![domain, subdomain].includes(ctx.domain)) {
        return res.status(403).send();
    }

    log(["DEBUG", "getquota", req.body]);
    if (!domain || !subdomain.endsWith(domain)) {
        return onError('EINVAL', 'getquota');
    }
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].indexOf(req.connection.remoteAddress) === -1) {
        return onError('ECONF', 'getauthorized',
            new Error("must be behind a http proxy remoteAddress: [" +
                req.connection.remoteAddress + "]"));
    }
    var todo = function () {
        ctx.knex('subscription').whereIn('status', ENABLED_STATUS).andWhere('benificiary_domain', domain)
            .select().then((arr) => {
            // Group all the data from the DB per plan purchased
            const plans = {};
            arr.forEach((elem) => {
                const plan = getBasePlan(elem.plan);
                // 'id' is the 'id' of the paid subscription in our database.
                // If this is a shared plan, it represents the id of the original plan (the paid one
                // containing extra subscriptions).
                let id = elem.id;

                // Shared plan: add this user to the list
                // A 'shared' plan is always linked to a plan created earlier and it should
                // always appear in this loop after the original plan.
                if (plan === 'shared') {
                    id = elem.plan_added;
                    if (plans[id]) {
                        plans[id].users.push(elem.benificiary_pubkey);
                    }
                    return;
                }
                // Add the plan to the list
                const basePlan = getBasePlan(plan);
                const lim = Plans[basePlan]?.quota;
                if (!lim) { return; }
                const limBytes = lim * 1024 * 1024 * 1024;
                plans[id] = {
                    limit: limBytes,
                    note: elem.gift_note,
                    plan: plan,
                    users: [elem.benificiary_pubkey]
                };
            });
            // Send limits per user. Each user will be linked to their biggest plan.
            const out = {};
            Object.keys(plans).forEach((id) => {
                const p = plans[id];
                p.users.forEach((k) => {
                    // For each user contained in this plan, check if they have a better plan.
                    // If they don't, give them the current plan
                    const existing = out[k];
                    if (existing && existing.limit > p.limit) { return; }
                    out[k] = {
                        limit: p.limit,
                        note: p.note,
                        plan: p.plan,
                        users: p.users
                    };
                });
            });
            res.send(out);
        }).catch((e) => {
            //console.error(e);
            onError('EDBGET', 'getauthorized', e);
        });
    };
    if (domain !== 'localhost:3000') {
        if (!req.headers['x-real-ip']) {
            return onError('ECONF', 'getauthorized', new Error("missing X-Real-IP"));
        }
        const client = req.headers['x-real-ip'].replace(/,.*$/, '');
        const ip4 = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(client);
        const ip6 = (!ip4 && /^[a-fA-F0-9:]+$/.test(client));
        if (!ip4 && !ip6) {
            return onError('ECONF', 'getauthorized', new Error("unexpected ip address"));
        }
        Dns.lookup(subdomain, { family: ip4? 4: 6, }, (err, addr) => {
            // specified subdomain does not exist
            if (err) {
                // don't log
                return void res.send({ message: 'ELOOKUP', location: 'getauthorized' });
            }
            if (addr !== client) {
                return onError('EAUTH', 'getauthorized', new Error("address not in subdomain"));
            }
            todo();
        });
        return;
    }
    // Local instance, don't check dns/ip
    todo();
};

// If we downgrade our plan, we may have too many extra drives
// and so, we may have to cancel them
const checkGifts = function (ctx, id, plan) {
    const basePlan = getBasePlan(plan); // no "12"
    const planData = Plans[basePlan];
    if (!planData) { return; }

    const allowed = planData.drives - 1; // -1 because our own drive

    // Count how many we've already used
    ctx.knex('subscription').where({
        plan_added: id,
        status: 'active'
    }).select().then((arr) => {
        var count = arr.length;
        if (count <= allowed) {
            // We don't have too many extra drives: do nothing
            return;
        }

        const toKeep = arr.slice(0, allowed).map((obj) => obj.id);

        // We've used more gifts than allowed in our new plan.
        // Cancel all but the first gift and update the first gift to use the new plan
        ctx.knex('subscription').where(function (builder) {
            builder.where({
                plan_added: id,
                status: 'active'
            }).whereNotIn('id', toKeep);
        }).update({
            status: 'canceled',
            end_time: now()
        }).asCallback((e) => {
            if (e) { log(['ERROR', 'checkGifts', e]); }
        });
    }).catch((e) => {
        log(['ERR', null, 'checkGifts', 'EDBCOUNT', e.message, e.stack]);
    });
};


const DAY_MILLISECONDS = 1000 * 60 * 60 * 24;
const queryStripe = (ctx, cb) => {
    let needQuery = [];
    let expiredSubs = [];
    nThen((waitFor) => {
        ctx.knex('subscription')
            .where('end_time', '<', now()).select('id').then(waitFor((arr) =>
        {
            expiredSubs = arr.map((el) => {
                return el.id;
            });
        }));
    }).nThen((waitFor) => {
        ctx.knex('subscription')
            .whereIn('status', ENABLED_STATUS)
            .andWhere(function () {
                this.whereIn('plan_added', expiredSubs).orWhere('end_time', '<', now());
            })
            .update({ status: 'canceled' })
            .asCallback(waitFor((e) =>
        {
            if (e) {
                log(['ERR', null, 'queryPlan', 'EDBGET', e.message, e.stack]);
                return;
            }
            // XXX TODO DPA
            //cancelDpa(ctx, expiredSubs); // gifts can't be org plans so we can use expiredSubs here
        }));
    }).nThen((waitFor) => {
        ctx.knex('subscription')
            .where(function () {
                this.whereIn('status', ENABLED_STATUS).orWhereNull('status');
            }).andWhere('last_checked_stripe', '<', Math.floor((now() - DAY_MILLISECONDS) / 1000))
            .andWhere({ admin_added: false })
            .andWhere({ plan_added: 0 })
            .select()
            .asCallback(waitFor((e, arr) =>
        {
            if (e) {
                log(['ERR', null, 'queryPlan', 'EDBGET', e.message, e.stack]);
                return;
            }
            needQuery = arr;
        }));
    }).nThen((waitFor) => {
        let nt = nThen;
        needQuery.forEach((nq) => {
            let plan = nq.plan;
            let status;
            let end_time = nq.end_time;
            let email = nq.email;
            let err;
            nt = nt((waitFor) => {
                log(['DEBUG', 'queryStripe', nq.id]);
                ctx.stripe.subscriptions.retrieve(nq.transaction, waitFor((e, subscription) => {
                    if (e && !err) {
                        err = e;
                    } else if (!subscription) {
                        err = {
                            message: "Invalid subscription for db entry " + nq.id
                        };
                    } else {
                        status = subscription.status;

                        // Check if the plans match between our DB and Stripe.
                        const checkPlan = getBasePlan(plan);
                        const price = subscription.plan.id;
                        const planData = Plans[checkPlan];
                        const match = planData?.id === price ||
                                      planData?.id_yearly === price;
                        if (!match) {
                            log(['WARNING', 'queryStripe', "mismatch plan", nq.id + '-' + nq.plan + '-' + subscription.plan.id]);
                            plan = getPlanFromPrice(price);
                        }

                        if (ENABLED_STATUS.indexOf(status) === -1) {
                            end_time = (subscription.current_period_start || subscription.canceled_at) * 1000;
                            // XXX TODO DPA
                            //cancelDpa(ctx, nq.id);
                        }
                    }
                }));
                if (!email) {
                    ctx.stripe.customers.retrieve(nq.customer, waitFor((e, customer) => {
                        if (e && !err) {
                            err = e;
                        } else if (!customer) {
                            err = {
                                message: "Invalid customer for db entry " + nq.id
                            };
                        } else {
                            email = customer.email;
                        }
                    }));
                }
            }).nThen((waitFor) => {
                if (err) {
                    log(['ERR', null, 'queryPlan', 'ESTRGET', err.message, err.stack]);
                    return;
                }
                ctx.knex('subscription').where({ id: nq.id }).update({
                    plan: plan,
                    status: status,
                    email: email,
                    end_time: end_time,
                    last_checked_stripe: Math.floor(now() / 1000)
                }).asCallback(waitFor((e) => {
                    if (e) {
                        log(['ERR', null, 'queryPlan', 'EDBPUT', e.message, e.stack]);
                    }
                    // If the plan has changed, check additional plans
                    if (plan !== nq.plan) {
                        checkGifts(ctx, nq.id, plan);
                    }
                }));
            }).nThen;
        });
        nt(waitFor());
    }).nThen(cb);
};
const initCycle = (ctx) => {
    // Query stripe regularly to check subscription status
    const again = () => {
        nThen((waitFor) => {
            if (now() - ctx.mut.lastCycle > config.periodicallyMs) {
                ctx.mut.lastCycle = now();
                try {
                    queryStripe(ctx, waitFor());
                } catch (e) {
                    console.error(e.message + ' - ' + (+new Date()));
                }
            }
        }).nThen(() => {
            setTimeout(again, 500);
        });
    };
    again();

    forceCryptPadUpdate();
};





const mkTables = (ctx, cb) => {
    nThen((waitFor) => {
        ctx.knex.schema.hasTable('subscription').then(waitFor(exists => {
            if (exists) { return; }
            ctx.knex.schema.createTable('subscription', (table) => {
                table.increments();
                // immediate
                table.string('domain').notNullable();
                table.string('pubkey').notNullable();
                table.string('benificiary_pubkey').notNullable();
                table.string('benificiary_domain').notNullable();
                table.string('benificiary_user');
                table.string('gift_note');
                table.string('jwt_msg').notNullable();
                table.string('customer').notNullable();
                table.string('transaction').notNullable();
                table.integer('iat').notNullable();
                table.string('status');
                table.boolean('admin_added').notNullable();
                table.integer('plan_added').notNullable();
                table.bigInteger('last_checked_stripe').notNullable();
                table.bigInteger('create_time').notNullable();
                table.bigInteger('end_time');
                // known after we talk to stripe
                table.string('plan');
                table.string('email');
            }).then(waitFor());
        }));
        ctx.knex.schema.hasTable('stripe').then(waitFor(exists => {
            if (exists) { return; }
            ctx.knex.schema.createTable('stripe', (table) => {
                table.increments();
                table.string('token').notNullable();
                table.bigInteger('sub_time').notNullable();
                table.string('pubkey').notNullable();
                table.string('domain').notNullable();
            }).then(waitFor());
        }));
        ctx.knex.schema.hasTable('dpa').then(waitFor(exists => {
            if (exists) { return; }
            ctx.knex.schema.createTable('dpa', (table) => {
                table.increments();
                // immediate
                table.integer('sub_id').notNullable();
                table.boolean('status').notNullable();
                table.bigInteger('create_time').notNullable();
                table.string('company_name').notNullable();
                table.string('company_user').notNullable();
                table.string('company_location').notNullable();
                table.string('company_id').notNullable();
                table.bigInteger('pdf_id').notNullable();
                table.bigInteger('signed_on');
            }).then(waitFor());
        }));
    }).nThen(cb);
};

let cachedPlans;
const servePlans = (req, res) => {
    if (cachedPlans) {
        res.setHeader('Content-Type', 'application/json');
        return void res.send(cachedPlans);
    }
    const json = Plans;
    const clone = JSON.parse(JSON.stringify(json));
    Object.keys(clone).forEach(key => {
        delete clone[key].id;
        delete clone[key].id_yearly;
    });
    cachedPlans = clone;
    servePlans(req, res);
};

const main = () => {
    const cryptpadURL = new URL(config.cryptpadOrigin);

    const ctx = Object.freeze({
        knex: Knex(config.database),
        stripe: Stripe(config.stripe.privateKey),
        app: Express(),
        config: config,
        domain: cryptpadURL.host,
        admins: config.admins.map((u) => (parseUser(u).pubkey)),
        mut: {
            lastCycle: 0
        },
        webhookSuccess: [],
        updateCryptPad: forceCryptPadUpdate,
        plans: {}
    });

    // Stripe webhook
    ctx.app.use(cors());
    ctx.app.post('/api/stripewebhook', Express.raw({ type: 'application/json' }),
            (req, res, buf) => {
        onStripeWebhook(ctx, req, res, buf);
    });

    // Authenticated commands
    ctx.app.use(Express.json());
    ctx.app.post('/api/auth', (req, res) => {
        AuthCommands.handle(ctx, req, res, false);
    });

    // Authenticated commands with upload (for DPA)
    const dpa = multer({ dest: './dpa/tmp' });
    ctx.app.post('/api/authblob', dpa.single('blob'), (req, res) => {
        AuthCommands.handle(ctx, req, res, true);
    });

    ctx.app.post('/api/getauthorized', (req, res) => {
        getAuthorized(ctx, req, res);
    });
    ctx.app.post('/api/getquota', (req, res) => {
        getQuota(ctx, req, res);
    });

    ctx.app.get('/api/plans', servePlans);

    nThen((waitFor) => {
        mkTables(ctx, waitFor());
    }).nThen(() => {
        initCycle(ctx);
        ctx.app.listen(config.httpPort, config.httpAddress, () => {
            log(['DEBUG', 'listening on port', config.httpPort]);
        });
    });
};
main();
