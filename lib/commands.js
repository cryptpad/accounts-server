const { isYearlyPlan, getBasePlan,
        parseUser, makeUser, ENABLED_STATUS, now,
        log, error, random,
        mkRandomCookie } = require('./utils');
const Plans = require('../config/plans');
const nThen = require('nthen');
const Dpa = require('./dpa');
const Fs = require('node:fs');

// UTILS

const isAdmin = (ctx, key) => {
    return ctx.admins.includes(key);
};

const getOrgPlans = () => {
    const res = [];
    const p = Object.keys(Plans).filter(k => {
        return Plans[k].org;
    });
    p.forEach(plan => {
        res.push(plan);
        res.push(plan + '12');
    });
    return res;
};

const getBestSub = arr => {
    let best = {
        plan: '',
        quota: 0,
        sub: undefined,
        yearly: false,
        owned: false
    };
    arr.forEach(sub => {
        const plan = sub.plan === "shared" ? sub.sharedplan
                                           : sub.plan;
        const p = getBasePlan(plan);
        const quota = Plans[p]?.quota;
        const owned = sub.pubkey === sub.benificiary_pubkey;
        if (!owned && best.owned) { return; }
        if (quota < best.quota) { return; }
        best.quota = quota;
        best.owned = owned;
        best.yearly = isYearlyPlan(sub.plan);
        best.plan = p;
        best.sub = sub;
    });
    return {
        plan: best.plan,
        yearly: best.yearly,
        id: best.sub?.id,
        stripeSub: best?.sub?.transaction,
        shared: best.sub.plan === 'shared',
        adminGift: best.sub.admin_added === 1,
        sub: best.sub
    };
};
const getExtraDrives = (ctx, id, cb) => {
    ctx.knex('subscription').whereIn('status', ENABLED_STATUS).andWhere({
        plan_added: id
    }).then((arr) => {
        if (!arr.length) {
            return void cb(void 0, []);
        }
        const res = {};
        arr.forEach(sub => {
            res[sub.id] = {
                name: sub.benificiary_user,
                key: sub.benificiary_pubkey
            };
        });
        cb(void 0, res);
    }).catch((err) => {
        error(['EDBCHECK', "Can't check extra drives",
                        err, new Date()]);
        cb(err);
    });

};
const getKnexSub = (ctx, publicKey, domain, cb) => {
    ctx.knex('subscription as m')
    .leftOuterJoin('subscription as s', 'm.plan_added', 's.id')
    .whereIn('m.status', ENABLED_STATUS).andWhere({
        'm.benificiary_domain': domain,
        'm.benificiary_pubkey': publicKey,
    }).select('m.*', 's.plan as sharedplan').then((arr) => {
        if (!arr.length) {
            return void cb(void 0, false);
        }
        const sub = getBestSub(arr);
        getExtraDrives(ctx, sub.id, (err, drives) => {
            if (err) {
                return void cb(err);
            }
            sub.drives = drives;
            cb(void 0, sub);
        });
    }).catch((err) => {
        error(['EDBCHECK', "Can't check existing subscriptions",
                        err, new Date()]);
        cb(err);
    });

};
const getStripeSub = (ctx, sub, cb) => {
    ctx.stripe.subscriptions.retrieve(sub, (err, data) => {
        if (err) {
            return void cb({
                code: 'ESTRIPEGET',
                stack: err,
                data: 'getsub'
            });
        }
        cb(void 0, data);
    });
};



const getDpaPlan = (ctx, pubkey, cb) => {
    ctx.knex('subscription')
        .whereIn('status', ENABLED_STATUS)
        .andWhere(function () {
            this.whereIn('plan', getOrgPlans());
        }).andWhere({
            benificiary_pubkey: pubkey,
            benificiary_domain: ctx.domain,
            // admin_added: 0 // XXX commented out to allow admin gifts to create DPA
    }).select().then((arr) => {
        if (arr.length === 0) {
            return void cb('NOPLAN');
        }
        cb(void 0, arr[0]);
    });
};
const createDpa = (ctx, pubkey, data, cb) => {
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };
    // Check if we have an org subscription
    getDpaPlan(ctx, pubkey, (err, sub) => {
        if (err || !sub) {
            return void cb(void 0, { allowed: false });
        }
        // Check if we already have a DPA
        ctx.knex('dpa').where('sub_id', sub.id).select().then((result) => {
            const time = new Date();
            if (result.length) {
                return onError('EEXISTS', 'dpa', new Error('Already exists'));
            }

            const pdfId = random();
            Dpa.run(data, time.toDateString(), pdfId+'.pdf').then(() => {
                ctx.knex('dpa').insert({
                    sub_id: sub.id,
                    status: 1,
                    create_time: +time,
                    company_name: data.name,
                    company_user: data.represented,
                    company_location: data.located_1 + ' ' + data.located_2,
                    company_id: data.identification,
                    pdf_id: pdfId
                }).then(() => {
                    cb(void 0, {done: true});
                }).catch((e) => {
                    error(['ERR', null, 'makedpa', 'EDBPUT', e.message, e.stack]);
                });
            }).catch((err) => {
                return onError('EPDF', 'dpa-pdf', err);
            });
        }).catch((err) => {
            onError('EDBGET', 'getdpa', err);
        });
    });
};
const getDpa = (ctx, pubkey, cb) => {
    getDpaPlan(ctx, pubkey, (err, sub) => {
        if (err || !sub) {
            return void cb(err || 'NOPLAN');
        }
        ctx.knex('dpa').where('sub_id', sub.id).select()
           .then((result) => {
            cb(null, result);
        }).catch(cb);
    });
};

const cancelDpa = () => {
    // XXX
};

// COMMANDS

const commands = {};

commands.SUBSCRIBE = async (ctx, json, cb) => {
    const { publicKey, domain, user, plan, isRegister } = json;

    log(['INFO', 'stripesub', 'begin_subs', json]);

    if (!domain) {
        error(['EINVAL', 'subscribe']);
        return void cb('SUBSCRIBE_INVAL');
    }

    const origin = ctx.config.cryptpadOrigin;
    const page = isRegister ? 'drive' : 'accounts';
    const success = `${origin}/accounts/#subscribe-${page}`;
    const cancel = `${origin}/${page}/`;

    const token = mkRandomCookie();
    const metadata = {
        key: publicKey,
        user: user,
        domain
    };

    const isYearly = isYearlyPlan(plan);
    const basePlan = getBasePlan(plan);
    const planData = Plans[basePlan];
    let price = isYearly ? planData?.id_yearly : planData?.id;
    if (!price) {
        // Fallback to other billing period if selected one
        // is not defined
        price = planData?.id_yearly || planData?.id;
    }
    if (!price) {
        return void cb('SUBSCRIBE_NOPLAN');
    }

    try {
        await ctx.knex('stripe').insert({
            token: token,
            sub_time: 0,
            pubkey: publicKey,
            domain: domain
        });
    } catch (e) {
        error([e]);
    }
    try {
        const session = await ctx.stripe.checkout.sessions.create({
            line_items: [{
                price: price,
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: success,
            cancel_url: cancel,
            client_reference_id: token,
            metadata: metadata,
            allow_promotion_codes: true,
            automatic_tax: {enabled: true},
            tax_id_collection : {enabled: true}
        });
        cb(void 0, {permalink: session.url});
    } catch (e) {
        error(['ESTRIPE', 'subscribe', e]);
        return void cb('SUBSCRIBE_STRIPE');
    }
};

commands.STRIPE_PORTAL = (ctx, json, cb) => {
    const { publicKey, domain, updateSub } = json;

    if (!domain) {
        error(['EINVAL', 'subscribe_domain', domain]);
        cb('INVALID_DOMAIN');
        return;
    }

    const origin = ctx.config.cryptpadOrigin;
    const redirect = `${origin}/accounts/`;

    ctx.knex('subscription').whereIn('status', ENABLED_STATUS).andWhere({
        benificiary_domain: domain,
        benificiary_pubkey: publicKey,
    }).select().then(async (result) => {
        const count = result.length;
        if (!count) {
            return void cb('ENOSUB');
        } else if (count > 1) {
            return void cb('ETOOMANY');
        }
        const sub = result[0];
        let suffix = '';
        if (updateSub) {
            suffix = '/subscriptions/'+sub.transaction+'/update';
        }
        const sessionCfg = {
            customer: sub.customer,
            return_url: redirect
        };
        const session = await ctx.stripe.billingPortal.sessions.create(sessionCfg);
        cb(void 0, {url: session.url+suffix});
    }).catch((err) => {
        error(['EDBGET', 'portal', err]);
        cb('EDBGET');
    });
};

commands.GET_MY_SUB = (ctx, json, cb) => {
    const { publicKey, domain } = json;
    //log(['INFO', 'getMySub', publicKey]);
    if (!publicKey || !domain) {
        error(['EAUTH', 'session']);
        return void cb('EAUTH');
    }

    let knexData;
    let stripeData;
    nThen(waitFor => {
        getKnexSub(ctx, publicKey, domain, waitFor((err, data) => {
            if (err || data === false) {
                waitFor.abort();
                const admin = isAdmin(ctx, publicKey);
                if (admin) {
                    return void cb(void 0, {
                        isAdmin: true
                    });
                }
                return void cb(err, data);
            }
            knexData = data;
        }));
    }).nThen(waitFor => {
        const sub = knexData.sub;
        if (sub.admin_added || sub.plan_added) { return; }
        getStripeSub(ctx, knexData.stripeSub, waitFor((err, data) => {
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            stripeData = data;
        }));
    }).nThen(() => {
        const renewal = stripeData?.items?.data[0].current_period_end;
        const canceled = !!stripeData?.cancel_at_period_end;
        cb(void 0, {
            id: knexData.id,
            plan: knexData.plan,
            yearly: knexData.yearly,
            renewal: renewal*1000,
            drives: knexData.drives,
            canceled,
            shared: knexData.shared,
            adminGift: knexData.adminGift,
            owner: knexData.sub?.pubkey,
            isAdmin: isAdmin(ctx, publicKey)
        });
    });
};

const checkExistingSubscription = (ctx, pubkey, domain, cb) => {
    ctx.knex('subscription').whereIn('status', ENABLED_STATUS).andWhere({
        benificiary_domain: domain,
        benificiary_pubkey: pubkey,
    }).count('id as count').then((result) => {
        var count = result.length && result[0].count;
        cb(null, !!count);
    }).catch((err) => {
        cb({
            code: 'EDBCOUNT',
            error: err
        });
    });
};
commands.ADD_TO_PLAN = (ctx, json, cb) => {
    const { publicKey, domain, addKey, giftNote } = json;

    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!domain) {
        return void onError('EINVAL', 'addtoplan');
    }

    let benificiary_domain = domain;
    let benificiary_pubkey;
    let benificiary_user;
    try {
        const parsed = parseUser(addKey);
        if (parsed.domain !== domain) {
            return void onError('EINVAL', 'addtoplan', 'Wrong domain');
        }
        benificiary_domain = parsed.domain;
        benificiary_pubkey = parsed.pubkey;
        benificiary_user = parsed.username;
    } catch (e) {
        return void onError('EINVAL', 'addtoplan', e);
    }

    const addAccount = function (sub) {
        const planId = sub.id;
        const toInsert = {
            customer: '_addToPlan_',
            transaction: '_addToPlan_',
            iat: 0,
            domain: domain,
            jwt_msg: '-',
            pubkey: publicKey,
            benificiary_domain: benificiary_domain,
            benificiary_pubkey: benificiary_pubkey,
            benificiary_user: benificiary_user,
            gift_note: giftNote,
            admin_added: false,
            plan_added: planId,
            plan: 'shared',
            last_checked_stripe: 0,
            status: 'active',
            create_time: now(),
            end_time: sub.end_time
        };
        ctx.knex('subscription').insert(toInsert).then((arr) => {
            log(['INFO', 'addtoplan', 'insert', json, arr[0]]);
            ctx.mut.lastCycle = 0;
            ctx.updateCryptPad();
            cb(void 0, { id: arr[0] });
        }).catch((e) => {
            //console.error(e);
            return void onError('EDBPUT', 'addtoplan', e.message);
        });
    };

    nThen((waitFor) => {
        // Make sure a user can't have 2 active subscriptions at the same time
        checkExistingSubscription(ctx, benificiary_pubkey, benificiary_domain, waitFor((err, exist) => {
            if (err) {
                waitFor.abort();
                return void onError(err.code, 'addtoplan/checkexisting', err.error);
            }
            if (exist) {
                waitFor.abort();
                return void onError('EEXISTS', 'addtoplan/checkexisting');
            }
        }));
    }).nThen(() => {
        // Check first if the user owns a valid plan
        ctx.knex('subscription').whereIn('status', ENABLED_STATUS)
            .andWhere({
                benificiary_pubkey: publicKey,
                benificiary_domain: domain,
        }).select().then((arr) => {
            if (!arr.length) {
                return void onError('EINVAL', 'addToPlan', new Error('no active plan'));
            }
            const best = getBestSub(arr);
            const planData = Plans[best.plan];
            const sub = best.sub;

            if (!planData?.drives || planData.drives === 1) {
                return onError('EINVAL', 'addToPlan', new Error('invalid plan'));
            }

            ctx.knex('subscription').where({
                plan_added: sub.id,
                status: 'active'
            }).count('id as count').then((result) => {
                const count = result.length && result[0].count;
                if (count < (planData.drives - 1)) {
                    addAccount(sub);
                    return;
                }
                return onError('EINVAL', 'addToPlan', new Error('limit reached'));
            }).catch((err) => {
                onError('EDBCOUNT', 'addtoplan', err.message);
            });
        }).catch((err) => {
            onError('EDBGET', 'addtoplan', err.message);
        });
    });
};



commands.CHECK_SESSION = (ctx, json, cb) => {
    const { publicKey, domain } = json;
    log(['INFO', 'checksession', publicKey]);
    if (!publicKey || !domain) {
        error(['EAUTH', 'session']);
        return void cb('EAUTH');
    }

    ctx.knex('subscription').whereIn('status', ENABLED_STATUS).andWhere({
        benificiary_domain: domain,
        benificiary_pubkey: publicKey,
    }).then((arr) => {
        cb(void 0, Boolean(arr.length));
    }).catch((err) => {
        error(['EDBCHECK', "Can't check existing subscriptions",
                        err, new Date()]);
        cb(err);
    });
};

commands.DPA_DOWNLOAD = (ctx, json, cb) => {
    const { publicKey, id, signed } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    let signed_str = '_signed';

    const admin = isAdmin(ctx, publicKey);
    if (admin && id) {
        if (!signed) { signed_str = ''; }
        return void cb(void 0, void 0, {
            path: './dpa/'+id+signed_str+'.pdf'
        });
    }

    getDpa(ctx, publicKey, (err, result) => {
        if (err || result?.length !== 1) {
            return void onError('EGETDPA', 'downloaddpa', err);
        }
        const pdfId = result[0].pdf_id;
        if (!result[0].signed_on) { signed_str = ''; }

        return void cb(void 0, void 0, {
            path: './dpa/'+pdfId+signed_str+'.pdf',
        });
    });
};

commands.DPA_GET = (ctx, json, cb) => {
    const { publicKey } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    getDpa(ctx, publicKey, (err, result) => {
        if (err === 'EFORBIDDEN' || err === 'NOPLAN') {
            return void cb(void 0, { allowed: false });
        }
        if (err) {
            return void onError('EGETDPA', 'getdpa', err);
        }
        if (result?.length === 0) {
            return void cb(void 0, {
                allowed: true,
                new: true
            });
        }
        const dpa = result[0];
        cb(void 0, {
            allowed: true,
            data: dpa
        });
    });
};
commands.DPA_CREATE = (ctx, json, cb) => {
    const { publicKey, data } = json;

    const obj = {
        name: data.name,
        represented: data.represented,
        located_1: data.located1,
        located_2: data.located2,
        identification: data.identification,
        language: data.language || 'en'
    };

    createDpa(ctx, publicKey, obj, cb);
};
commands.DPA_SIGN = (ctx, json, cb) => {
    const { publicKey, file } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    const removeFile = function (cb) {
        if (!file) { return; }
        Fs.unlink(file.path, (err) => {
            if (err) {
                log(['ERROR', 'deleteDpa', err, file.path]);
            }
            cb();
        });
    };

    // Check if we have an org subscription
    getDpa(ctx, publicKey, (err, result) => {
        if (err) {
            return removeFile(() => {
                onError('EGETDPA', 'dpaupload', err);
            });
        }
        if (result.length !== 1) {
            return removeFile(() => {
                onError('EPLAN', 'dpaupload', new Error('No plan'));
            });
        }
        const dpa = result[0];
        // Make sure it's not already signed
        if (dpa.signed_on) {
            return removeFile(() => {
                onError('ESIGN', 'dpaupload', new Error('Dpa already signed'));
            });
        }

        // We have an unsigned DPA: move the uploaded file
        const newPath = `./dpa/${dpa.pdf_id}_signed.pdf`;
        Fs.rename(file.path, newPath, (err) => {
            if (err) {
                return onError('EMOVE', 'dpaupload', new Error('DPA move error'), dpa, file.path);
            }

            // Mark as signed in our DB
            ctx.knex('dpa').where({ id: dpa.id }).update({
                signed_on: now()
            }).asCallback((err) => {
                if (err) {
                    return onError('EDBUPDATE', 'dpaupload', new Error('Sign'));
                }
                cb(void 0, {done: true});
            });
        });
    });
};

commands.CANCEL_GIFT = (ctx, json, cb) => {
    const { publicKey, id } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!id) { return void onError('EINVAL', 'cancel'); }

    ctx.knex('subscription').where({
        pubkey: publicKey,
        id: id
    }).orWhere({
        benificiary_pubkey: publicKey,
        id: id
    }).select().then((arr) => {
        if (!arr[0]) {
            return void onError('ENOTFOUND', 'cancel');
        }
        const sub = arr[0];
        // 1. Cancelling a gift we received (admin or plan)
        //    --> check if we are NOT the owner of the plan
        if (sub.pubkey !== publicKey) {
            ctx.knex('subscription').where({
                benificiary_pubkey: publicKey,
                id: id
            }).update({
                status: 'canceled',
                end_time: now()
            }).asCallback((e) => {
                if (e) {
                    return void onError('EDBPUT', 'cancel', e);
                }

                // Make sure we cancel DPA for org plans
                // XXX
                cancelDpa(ctx, id);
                ctx.mut.lastCycle = 0;
                cb(void 0, {});
            });
            return;
        }

        // 2. Cancelling a gift we made to another user/team
        //    or an admin gift
        //    --> we are the owner, check if there is a plan_added
        if (sub.admin_added || sub.plan_added) {
            ctx.knex('subscription').where({
                pubkey: publicKey,
                id: id
            }).orWhere({
                pubkey: publicKey,
                // admin may give shareable plans, so also cancel
                // the shared ones
                plan_added: Number(id)
            }).update({
                status: 'canceled',
                end_time: now()
            }).asCallback((e) => {
                if (e) {
                    return void onError('EDBPUT', 'cancel', e);
                }
                // Make sure we cancel DPA for org plans
                // XXX
                cancelDpa(ctx, id);
                ctx.mut.lastCycle = 0;
                cb(void 0, {});
            });
            return;
        }

        // 3. Cancelling a paid account
        // XXX This shouldn't happen: users should only cancel from
        // stripe portal
        error(['ERROR', 'cancel', "cancelling without stripe", sub.transaction]);
        return void cb('NOT_IMPLEMENTED');
        /*
        ctx.stripe.subscriptions.update(sub.transaction,
                                     { cancel_at_period_end: true },
                                     (err, confirmation) => {
            if (err) {
                return void onError('EDSTRPOST', 'cancel', err);
            }
            ctx.knex('subscription').where({
                pubkey: publicKey,
                id: id
            }).orWhere({
                pubkey: publicKey,
                plan_added: Number(id)
            }).update({
                end_time: confirmation.current_period_end * 1000,
            }).asCallback((e) => {
                if (e) {
                    return void onError('EDBPUT', 'cancel', e);
                }

                cancelDpa(ctx, id);
                ctx.mut.lastCycle = 0;
                cb(void 0, {});
            });
        });
        */
    }).catch((e) => {
        onError('EDBGET', 'cancel', e);
    });
};

commands.ADMIN_GET_ALL = (ctx, json, cb) => {
    const { publicKey } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'getall');
    }

// XXX TODO
// Add "limit(100)" and offset
// and load asyncrhonously

    let result = {};
    nThen(function (waitFor) {
        ctx.knex('subscription').select().then(waitFor((arr) => {
            result.subs = arr.map((obj) => ({
                id: obj.id,
                pubkey: obj.pubkey,
                benificiary: obj.benificiary_user ? makeUser({
                    username: obj.benificiary_user || '',
                    pubkey: obj.benificiary_pubkey,
                    domain: obj.benificiary_domain
                }) : undefined,
                benificiary_pubkey: obj.benificiary_pubkey,
                benificiary_domain: obj.benificiary_domain,
                benificiary_user: obj.benificiary_user || '',
                domain: obj.domain,
                customer: obj.customer,
                gift_note: obj.gift_note,
                plan: obj.plan,
                plan_added: obj.plan_added,
                status: obj.status,
                create_time: obj.create_time || '',
                end_time: obj.end_time || '',
                email: obj.email
            }));
        })).catch((e) => {
            waitFor.abort();
            onError('EDBGET', 'getall', e);
        });
    }).nThen(function () {
        cb(void 0, result);
    });
};

commands.ADMIN_GET_SUB = (ctx, json, cb) => {
    const { publicKey, id, email } = json;
    let key = json?.key;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'getone');
    }

    if (key && (key.length !== 44 || key.slice(-1) !== "=")) {
        const parsed = parseUser(key);
        key = parsed.pubkey;
    }

    const where = id ? { id: id } :
                    (email ? { email: email } :
                        { benificiary_pubkey: key });
    const orWhere = id ? { plan_added: id } :
                    (email ? { email: email } : { pubkey: key });
    ctx.knex('subscription').where(where).orWhere(orWhere).select().then((arr) => {
        cb(void 0, arr.map((obj) => ({
            id: obj.id,
            pubkey: obj.pubkey,
            benificiary: obj.benificiary_user ? makeUser({
                username: obj.benificiary_user || '',
                pubkey: obj.benificiary_pubkey,
                domain: obj.benificiary_domain
            }) : undefined,
            benificiary_pubkey: obj.benificiary_pubkey || '',
            benificiary_domain: obj.benificiary_domain,
            benificiary_user: obj.benificiary_user,
            domain: obj.domain,
            gift_note: obj.gift_note,
            plan: obj.plan,
            plan_added: obj.plan_added,
            admin_added: obj.admin_added,
            status: obj.status,
            create_time: obj.create_time,
            end_time: obj.end_time || '',
            email: obj.email || '',
            customer: obj.customer,
            transaction: obj.transaction
        })));
    }).catch((err) => {
        onError('EDBGET', 'getsubsadmin', err);
    });
};

commands.ADMIN_UPDATE_SUB = (ctx, json, cb) => {
    const { publicKey, data } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'getone');
    }

    const id = data.id;
    const trial = Number(data.trial);
    delete data.id;
    delete data.trial;

    data.plan_added = Number(data.plan_added);
    data.admin_added = Number(data.admin_added);
    if (data.benificiary_user === "") {
        data.benificiary_user = null;
    }
    if (data.update_time === "") {
        data.update_time = null;
    }
    if (data.end_time === "") {
        data.end_time = null;
    }

    ctx.knex('subscription').where({ id: id })
       .update(data).asCallback((e) => {
        if (e) {
            return onError('EDBPUT', 'updatesubadmin', e);
        }
        const todo = function () {
            ctx.mut.lastCycle = 0;
            cb(void 0, {});
        };
        if (trial && data.transaction) {
            let timestamp;
            if (trial === -1) {
                timestamp = 'now';
            } else {
                // Number of days
                let trialDate = new Date();
                trialDate.setDate(trialDate.getDate() + trial);
                timestamp = Math.round(trialDate.getTime() / 1000);
            }
            ctx.stripe.subscriptions.update(data.transaction, {
                 trial_end: timestamp, prorate: false
            }, (err) => {
                if (err) {
                    return onError('EDSTRPOST', 'updatesub', err);
                }
                todo();
            });
            return;
        }
        todo();
    });
};

commands.ADMIN_GET_DPA = (ctx, json, cb) => {
    const { publicKey } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'getone');
    }
    ctx.knex('dpa').where('status', 1).select().then((result) => {
        cb(void 0, result);
    }).catch((err) => {
        onError('EDBGET', 'getdpa', err);
    });
};
commands.ADMIN_CANCEL_DPA = (ctx, json, cb) => {
    const { publicKey, id } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'getone');
    }

    ctx.knex('dpa').where('id', id).select().then((result) => {
        if (result.length !== 1) {
            onError('ENOTFOUND', 'canceldpa', new Error('No pubkey'));
            return;
        }
        let dpa = result[0];
        ctx.knex('dpa').where('id', id).delete().then(() => {
            cb(void 0, {});
            try {
                Dpa.remove(dpa.pdf_id+'.pdf');
                Dpa.remove(dpa.pdf_id+'_signed.pdf');
            } catch (e) {
                log(['ERR', null, 'removedpa', 'unlink', e.message, e.stack]);
            }
        }).catch((err) => {
            onError('EDBDEL', 'canceldpa', err);
        });
    }).catch((err) => {
        onError('EDBGET', 'getdpa', err);
    });
};
commands.ADMIN_CREATE_DPA = (ctx, json, cb) => {
    const { publicKey, data } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'getone');
    }

    const userKey = data.userKey;
    const obj = {
        name: data.name,
        represented: data.represented,
        located_1: data.located1,
        located_2: data.located2,
        identification: data.identification,
        language: data.language || 'en'
    };

    createDpa(ctx, userKey, obj, cb);
};
commands.ADMIN_UNSIGN_DPA = (ctx, json, cb) => {
    const { publicKey, id } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'getone');
    }

    ctx.knex('dpa').where('id', id).select().then((result) => {
        if (result.length !== 1) {
            onError('ENOTFOUND', 'unsigndpa', new Error('No pubkey'));
            return;
        }
        var dpa = result[0];
        ctx.knex('dpa').where('id', id).update({
            signed_on: null
        }).then(() => {
            cb(void 0, {});
            try {
                Dpa.remove(dpa.pdf_id+'_signed.pdf');
            } catch (e) {
                log(['ERR', null, 'removesigneddpa', 'unlink', e.message, e.stack]);
            }
        }).catch((err) => {
            onError('EDBDEL', 'unsigndpa', err);
        });
    }).catch((err) => {
        onError('EDBGET', 'unsigndpa', err);
    });
};

commands.ADMIN_GIFT = (ctx, json, cb) => {
    const { publicKey, key, plan, note } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'forcesync');
    }

    let parsed = {};
    try {
        parsed = parseUser(key);
    } catch (e) {
        return onError('EINVAL', 'subscribe', e);
    }

    const data = {
        domain: ctx.domain,
        pubkey: publicKey,
        benificiary_domain: parsed.domain,
        benificiary_pubkey: parsed.pubkey,
        benificiary_user: parsed.username,
        plan: plan,
        status: 'active',
        create_time: now(),
        admin_added: 1,
        plan_added: 0,
        gift_note: note,
        last_checked_stripe: 0,
        jwt_msg: '',
        customer: '_admin_',
        transaction: '_admin_',
        iat: 0,
    };

    nThen((w) => {
        const key = parsed.pubkey;
        const domain = parsed.domain;
        checkExistingSubscription(ctx, key, domain, w((err, exist) => {
            if (err) {
                onError(err.code, 'admingift/checkexisting', err.message);
                return void w.abort();
            }
            if (exist) {
                cb(void 0, { error: 'EEXISTS' });
                return void w.abort();
            }
        }));
    }).nThen(() => {
        ctx.knex('subscription').insert(data).then((arr) => {
            log(['INFO', 'subscribe', 'insert', data, arr[0]]);
            ctx.mut.lastCycle = 0;
            cb(void 0, { id: arr[0] });
            ctx.updateCryptPad();
        }).catch((e) => {
            onError('EDBPUT', 'subscribe', e);
        });
    });
};

commands.ADMIN_FORCE_SYNC = (ctx, json, cb) => {
    const { publicKey, id } = json;
    const onError = (...args) => {
        error(args);
        cb(args[0]);
    };

    if (!isAdmin(ctx, publicKey)) {
        return onError('EFORBIDDEN', 'forcesync');
    }

    ctx.knex('subscription').where({ id: id })
       .update({last_checked_stripe: 0}).asCallback((e) => {
        if (e) {
            return onError('EDBPUT', 'updatesubadmin', e);
        }
        ctx.mut.lastCycle = 0;
        cb(void 0, {});
    });
};

module.exports = commands;
