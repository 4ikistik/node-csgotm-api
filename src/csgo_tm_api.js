import got from 'got';
import util from 'util';
import extend from 'extend';
import clone from 'clone';
import Bottleneck from "bottleneck";
import parseCSV from 'csv-parse';
import NestedError from 'nested-error-stacks';

/**
 * API error
 */
class CSGOtmAPIError extends NestedError {
    constructor(message, nested) {
        super(message, nested);
        this.name = this.constructor.name;
    }
}


/**
 * API
 * https://market.csgo.com/docs/
 */
class CSGOtmAPI {
    static get defaultAppId() {
        return 730;
    }

    static get defaultBaseUrl() {
        return 'https://market.csgo.com/';
    };

    /**
     * @param {Object} [options]
     *
     * @property {String}     [options.baseUrl='https://market.csgo.com/'] Base url with trailing slash
     * @property {String}     [options.apiPath='api'] Relative path to api
     * @property {String}     [options.apiKey=false] API key (required)
     * @property {Boolean}    [options.useLimiter=true] Using request limiter
     * @property {Object}     [options.defaultGotOptions={}] Default parameters for 'got' module
     * @property {Object}     [options.limiterOptions={}] Parameters for 'bottleneck' module
     *
     * @throws {CSGOtmAPIError}
     */
    constructor(options={}) {
        if (!options.apiKey) {
            throw new CSGOtmAPIError('API key required');
        }
        // Adds trailing slash
        if (options.baseUrl) {
            if (!options.baseUrl.endsWith('/')) {
                options.baseUrl += '/';
            }
        }

        this.options = {};
        extend(true, this.options, {
            baseUrl: CSGOtmAPI.defaultBaseUrl,
            apiPath: 'api',
            useLimiter: true,
            limiterOptions: {
                maxConcurrent: 1, // 1 request at time
                minTime: 200,  // Max 5 requests per seconds
                highWater: -1,
                strategy: Bottleneck.strategy.LEAK,
                rejectOnDrop: true
            },
            defaultGotOptions: {}
        }, options);

        /**
         *  CSGO.TM API has a limit of 5 requests per second.
         *  If you violate this restriction, your API key will become invalid
         */
        if (this.options.useLimiter) {
            let limiterOptions = this.options.limiterOptions;
            this.limiter = new Bottleneck(
                limiterOptions.maxConcurrent,
                limiterOptions.minTime,
                limiterOptions.highWater,
                limiterOptions.strategy,
                limiterOptions.rejectOnDrop
            );
        }
    }

    /**
     * Available languages
     *
     * @returns {{EN: string, RU: string}}
     */
    static get LANGUAGES() {
        return {
            EN: 'en',
            RU: 'ru'
        };
    }


    /**
     * JSON request
     *
     * @param {String} url
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    static requestJSON(url, gotOptions = {}) {
        gotOptions = clone(gotOptions || {});
        gotOptions.json = true;

        return got(url, gotOptions).then(response => {
            let body = response.body;

            if (body.error) {
                let errorMessage = String(body.error);
                if (body.result) {
                    errorMessage += `. ${body.result}`;
                }

                throw new CSGOtmAPIError(errorMessage);
            }
            else {
                return body;
            }
        }).catch(error => {
            throw new CSGOtmAPIError(error.message, error);
        });
    }

    /**
     * Get current item DB name
     *
     * @param {Number} [appId] Steam app id that we want to get
     * @param {String} [baseUrl] Market base url
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    static dbName(appId = CSGOtmAPI.defaultAppId, baseUrl = CSGOtmAPI.defaultBaseUrl, gotOptions = {}) {
        let url = `${baseUrl}itemdb/current_${appId}.json`;

        return CSGOtmAPI.requestJSON(url, gotOptions);
    }

    /**
     * Get current database file data
     *
     * @param {String} dbName
     * @param {String} [baseUrl] Market base url
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    static itemDb(dbName, baseUrl = CSGOtmAPI.defaultBaseUrl, gotOptions = {}) {
        let url = `${baseUrl}itemdb/${dbName}`;

        return new Promise((resolve, reject) => {
            got(url, gotOptions).then(response => {
                parseCSV(
                    response.body,
                    {
                        columns: true,
                        delimiter: ';'
                    },
                    (err, data) => {
                        if (err) {
                            reject(err);
                        }
                        else {
                            resolve(data);
                        }
                    }
                );
            }).catch(error => {
                reject(error);
            });
        });
    }

    /**
     * Gets current item DB from CSGO.TM
     *
     * @param {Number} [appId] Steam app id that we want to get
     * @param {String} [baseUrl] Market base url
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    static currentItemDb(appId = CSGOtmAPI.defaultAppId, baseUrl = CSGOtmAPI.defaultBaseUrl, gotOptions = {}) {
        return CSGOtmAPI.dbName(appId, baseUrl, gotOptions).then((data) => {
            return CSGOtmAPI.itemDb(data.db, baseUrl, gotOptions);
        });
    }

    /**
     * Get list of the last 50 purchases
     *
     * @param {String} [baseUrl] Market base url
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    static history(baseUrl = CSGOtmAPI.defaultBaseUrl, gotOptions = {}) {
        let url = `${baseUrl}history/json/`;

        return CSGOtmAPI.requestJSON(url, gotOptions);
    }

    /**
     * Formalizes some item ids
     *
     * @param {Object} item Item object that you got from API, or you have created by yourself
     * @param {Boolean} [asNumbers] Should we convert ids to numbers?
     *
     * @returns {{classId: string, instanceId: string}}
     */
    static getItemIds(item, asNumbers=false) {
        let ids = {
            classId: String(item.i_classid || item.classid || item.classId),
            instanceId: String(item.i_instanceid || item.instanceid || item.instanceId || 0),
        };
        if (ids.instanceId === '0' && item.ui_real_instance) {
            ids.instanceId = String(item.ui_real_instance);
        }

        if (!asNumbers) {
            return ids;
        }
        else {
            return {
                classId: Number(ids.classId),
                instanceId: Number(ids.instanceId),
            };
        }
    }

    /**
     * Format item to needed query string
     *
     * @param {Object} item Item object that you got from API, or you have created by yourself
     * @param {String} [symbol] Separator
     *
     * @returns {string}
     */
    static formatItem(item, symbol = '_') {
        let ids = CSGOtmAPI.getItemIds(item);

        return ids.classId + symbol + ids.instanceId;
    }

    /**
     * Get API url
     *
     * @returns {string}
     */
    get apiUrl() {
        return this.options.baseUrl + this.options.apiPath;
    }

    /**
     * Limit requests, if need
     *
     * @param {Function} callback returning {Promise}
     *
     * @returns {Promise}
     */
    limitRequest(callback) {
        if (this.options.useLimiter) {
            return this.limiter.schedule(callback);
        }
        else {
            return callback();
        }
    }

    /**
     * Simple API call with key
     *
     * @param {String} method
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    callMethodWithKey(method, gotOptions = {}) {
        let url = `${this.apiUrl}/${encodeURI(method)}/?key=${this.options.apiKey}`;
        if (!Object.keys(gotOptions).length) {
            gotOptions = this.options.defaultGotOptions;
        }

        return this.limitRequest(() => {
            return CSGOtmAPI.requestJSON(url, gotOptions);
        });
    }


    /**
     * Simple API call with added item url
     *
     * @param {Object} item
     * @param {String} method
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    callItemMethod(item, method, gotOptions = {}) {
        method = `${method}/${CSGOtmAPI.formatItem(item)}`;

        return this.callMethodWithKey(method, gotOptions);
    }

    /**
     * -------------------------------------
     * Account methods
     * -------------------------------------
     */


    /**
     * Getting the Steam inventory, only those items that you have not already put up for sale
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetSteamInventory(gotOptions = {}) {
        return this.callMethodWithKey('GetInv', gotOptions);
    }

    /**
     * Getting the info about items in trades
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetTrades(gotOptions = {}) {
        return this.callMethodWithKey('Trades', gotOptions);
    }

    /**
     * Get account balance
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetMoney(gotOptions = {}) {
        return this.callMethodWithKey('GetMoney', gotOptions);
    }

    /**
     * Ping that you in online
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountPingPong(gotOptions = {}) {
        return this.callMethodWithKey('PingPong', gotOptions);
    }

    /**
     * Stop your trades
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGoOffline(gotOptions = {}) {
        return this.callMethodWithKey('GoOffline', gotOptions);
    }

    /**
     * Set token
     *
     * @param {String} token from steam trade url
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountSetToken(token, gotOptions = {}) {
        let method = `SetToken/${token}`;

        return this.callMethodWithKey(method, gotOptions);
    }

    /**
     * Get token
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetToken(gotOptions = {}) {
        return this.callMethodWithKey('GetToken', gotOptions);
    }

    /**
     * Get key for auth on websockets
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetWSAuth(gotOptions = {}) {
        return this.callMethodWithKey('GetWSAuth', gotOptions);
    }

    /**
     * Update cache of steam inventory
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountUpdateInventory(gotOptions = {}) {
        return this.callMethodWithKey('UpdateInventory', gotOptions);
    }

    /**
     * Getting cache status of inventory
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetCacheInfoInventory(gotOptions = {}) {
        return this.callMethodWithKey('InventoryItems', gotOptions);
    }

    /**
     * Getting operation history of period
     *
     * @param {Date} from
     * @param {Date} to
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetOperationHistory(from, to, gotOptions = {}) {
        let method = 'OperationHistory/%s/%s';
        let fromUnixtime = Math.floor(from.getTime() / 1000);
        let toUnixtime = Math.floor(to.getTime() / 1000);

        method = util.format(method, fromUnixtime, toUnixtime);

        return this.callMethodWithKey(method, gotOptions);
    }

    /**
     * Getting discounts
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetDiscounts(gotOptions = {}) {
        return this.callMethodWithKey('GetDiscounts', gotOptions);
    }

    /**
     * Getting counters from https://market.csgo.com/sell/
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetCounters(gotOptions = {}) {
        return this.callMethodWithKey('GetCounters', gotOptions);
    }

    /**
     * Getting items of profile with hash
     *
     * @param {String} hash
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetProfileItems(hash, gotOptions = {}) {
        return this.callMethodWithKey('GetProfileItems', gotOptions);
    }

    /**
     * Getting items from sell offers
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetItemsSellOffers(gotOptions = {}) {
        return this.callMethodWithKey('GetMySellOffers', gotOptions);
    }

    /**
     * Get a list of items that have been sold and must be passed to the market bot using the ItemRequest method.
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    accountGetItemsToGive(gotOptions = {}) {
        return this.callMethodWithKey('GetItemsToGive', gotOptions);
    }


    /**
     * -------------------------------------
     * Items methods
     * -------------------------------------
     */

    /**
     * Get item info
     *
     * @param {Object} item
     * @param {String} [language='ru'] One of static LANGUAGES
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetInfo(item, language, gotOptions = {}) {
        let url = `ItemInfo/${CSGOtmAPI.formatItem(item)}`;
        language = language || CSGOtmAPI.LANGUAGES.RU;
        url = `${url}/${language}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Get item history
     *
     * @param {Object} item
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetHistory(item, gotOptions = {}) {
        return this.callItemMethod(item, 'ItemHistory', gotOptions);
    }

    /**
     * Get item hash of 'Float Value'
     *
     * @param {Object} item
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetFloatHash(item, gotOptions = {}) {
        return this.callItemMethod(item, 'GetFloatHash', gotOptions);
    }

    /**
     * Get item sell offers
     *
     * @param {Object} item
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetSellOffers(item, gotOptions = {}) {
        return this.callItemMethod(item, 'SellOffers', gotOptions);
    }

    /**
     * Get item bet sell offer
     *
     * @param {Object} item
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetBestSellOffer(item, gotOptions = {}) {
        return this.callItemMethod(item, 'BestSellOffer', gotOptions);
    }

    /**
     * Get item buy offers
     *
     * @param {Object} item
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetBuyOffers(item, gotOptions = {}) {
        return this.callItemMethod(item, 'BuyOffers', gotOptions);
    }

    /**
     * Get item best buy offer
     *
     * @param {Object} item
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetBestBuyOffer(item, gotOptions = {}) {
        return this.callItemMethod(item, 'BestBuyOffer', gotOptions);
    }

    /**
     * Get item description for method 'buy'
     *
     * @param {Object} item
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemGetDescription(item, gotOptions = {}) {
        return this.callItemMethod(item, 'GetItemDescription', gotOptions);
    }

    /**
     * Available types of 'SELL' and 'BUY' param in 'MassInfo' request
     *
     * @returns {{NOTHING: number, TOP_50_SUGGESTIONS: number, TOP_SUGGESTION: number}}
     */
    static get MASS_INFO_SELL_BUY() {
        return {
            NOTHING: 0,
            TOP_50_SUGGESTIONS: 1,
            TOP_SUGGESTION: 2
        };
    };

    /**
     * Available types of 'HISTORY' param in 'MassInfo' request
     *
     * @returns {{NOTHING: number, LAST_100_SELLS: number, LAST_10_SELLS: number}}
     */
    static get MASS_INFO_HISTORY() {
        return {
            NOTHING: 0,
            LAST_100_SELLS: 1,
            LAST_10_SELLS: 2
        };
    };

    /**
     * Available types of 'INFO' param in `MassInfo` request
     *
     * @returns {{NOTHING: number, BASE: number, EXTENDED: number, MAXIMUM: number}}
     */
    static get MASS_INFO_INFO() {
        return {
            NOTHING: 0,
            BASE: 1,
            EXTENDED: 2,
            MAXIMUM: 3
        };
    };

    /**
     * Default params that will be substituted, when you did not provide some of them
     *
     * @returns {{sell: number, buy: number, history: number, info: number}}
     */
    static get DEFAULT_MASS_INFO_PARAMS() {
        return {
            sell: CSGOtmAPI.MASS_INFO_SELL_BUY.NOTHING,
            buy: CSGOtmAPI.MASS_INFO_SELL_BUY.NOTHING,
            history: CSGOtmAPI.MASS_INFO_HISTORY.NOTHING,
            info: CSGOtmAPI.MASS_INFO_INFO.BASE,
        };
    };


    /**
     * Getting more info about item
     *
     * @param {Array|Object} items One item or array of items
     * @param {Object} [params] Request params
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    itemMassInfo(items, params = {}, gotOptions = {}) {
        if (!Object.keys(gotOptions).length) {
            gotOptions = clone(this.options.defaultGotOptions);
        }
        else {
            gotOptions = clone(gotOptions);
        }

        // [SELL], [BUY], [HISTORY], [INFO]
        let url = 'MassInfo/%s/%s/%s/%s';

        if (!Array.isArray(items)) {
            items = [items];
        }

        params = params || {};
        extend(true, params, CSGOtmAPI.DEFAULT_MASS_INFO_PARAMS);

        url = util.format(url,
            params.sell,
            params.buy,
            params.history,
            params.info
        );

        let list = [];
        items.forEach(item => {
            list.push(CSGOtmAPI.formatItem(item));
        });

        gotOptions.body = {
            list: list.toString()
        };

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * -------------------------------------
     * Sell methods
     * -------------------------------------
     */

    /**
     * Creating new sell
     *
     * @param {Object} item
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    sellCreate(item, price, gotOptions = {}) {
        let url = `SetPrice/new_${CSGOtmAPI.formatItem(item)}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Updating price of sell
     *
     * @param {String} itemId Item ui_id from 'accountGetTrades' method
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    sellUpdatePrice(itemId, price, gotOptions = {}) {
        let url = `SetPrice/${String(itemId)}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Available types of `sellCreateTradeRequest` method
     *
     * @returns {{IN: string, OUT: string}}
     */
    static get CREATE_TRADE_REQUEST_TYPE() {
        return {
            IN: 'in',
            OUT: 'out'
        };
    };

    /**
     * Create trade request
     *
     * @param {String} botId Bot ui_bid from 'accountGetTrades' method (with ui_status = 4)
     * @param {String} type CREATE_TRADE_REQUEST_TYPE type
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    sellCreateTradeRequest(botId, type = 'out', gotOptions = {}) {
        let types = CSGOtmAPI.CREATE_TRADE_REQUEST_TYPE;
        if (!types[type]) {
            type = types.OUT;
        }

        let url = `ItemRequest/${type}/${String(botId)}`;
        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Getting market trades
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    sellGetMarketTrades(gotOptions = {}) {
        return this.callMethodWithKey('MarketTrades', gotOptions);
    }

    /**
     * Massive update prices
     *
     * @param {Object} item Item object with claasid and instanceid or with market_hash_name
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    sellMassUpdatePrice(item, price, gotOptions = {}) {
        let name;
        try {
            name = CSGOtmAPI.formatItem(item);
        } catch(e) {
            name = item.market_hash_name || item.market_name;
        }

        let url = `MassSetPrice/${name}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Massive update prices by item id
     *
     * @param {Object} prices Object with item ui_id as a key and its new price as value
     * @param {Object} [gotOptions]
     * @todo: untested
     *
     * @return {Promise}
     */
    sellMassUpdatePriceById(prices, gotOptions = {}) {
        if (!Object.keys(gotOptions).length) {
            gotOptions = clone(this.options.defaultGotOptions);
        }
        else {
            gotOptions = clone(gotOptions);
        }

        let list = {};
        for(let ui_id in prices) {
            list[Number(ui_id)] = Number(prices[ui_id]);
        }

        gotOptions.body = {
            list
        };

        return this.callMethodWithKey('MassSetPriceById', gotOptions);
    }

    /**
     * -------------------------------------
     * Buy methods
     * -------------------------------------
     */

    /**
     * Creating new buy
     *
     * @param {Object} item May have hash property
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    buyCreate(item, price, gotOptions = {}) {
        let url = `Buy/${CSGOtmAPI.formatItem(item)}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        if (item.hash) {
            url += `/${item.hash}`;
        }

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * -------------------------------------
     * Order methods
     * -------------------------------------
     */

    /**
     * Getting list of orders
     *
     * @param {Number} page For pagination
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    orderGetList(page = null, gotOptions = {}) {
        let url = 'GetOrders';
        page = parseInt(page);
        if (!isNaN(page) && page > 0) {
            url = `${url}/${String(page)}`;
        }

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Creating new order
     *
     * @param {Object} item
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    orderCreate(item, price, gotOptions = {}) {
        let url = `InsertOrder/${CSGOtmAPI.formatItem(item, '/')}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        if (item.hash) {
            url += `/${item.hash}`;
        }

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Updating or removing order. If price = 0, then order will be removed, else updated
     *
     * @param {Object} item
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    orderUpdateOrRemove(item, price, gotOptions = {}) {
        let url = `UpdateOrder/${CSGOtmAPI.formatItem(item, '/')}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Create, Update or Remove order
     *
     * @param {Object} item
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    orderProcess(item, price, gotOptions = {}) {
        let url = `ProcessOrder/${CSGOtmAPI.formatItem(item, '/')}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * Deleting all orders
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    orderDeleteAll(gotOptions = {}) {
        return this.callMethodWithKey('DeleteOrders', gotOptions);
    }

    /**
     * Getting status of order system
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    orderSystemStatus(gotOptions = {}) {
        return this.callMethodWithKey('StatusOrders', gotOptions);
    }

    /**
     * Getting the last 100 orders
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    orderGetLog(gotOptions = {}) {
        return this.callMethodWithKey('GetOrdersLog', gotOptions);
    }

    /**
     * -------------------------------------
     * Notification methods
     * -------------------------------------
     */

    /**
     * Getting notification
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    notificationGet(gotOptions = {}) {
        return this.callMethodWithKey('GetNotifications', gotOptions);
    }

    /**
     * Update or remove notification.
     *
     * @param {Object} item
     * @param {Number} price
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    notificationProcess(item, price, gotOptions = {}) {
        let url = `UpdateNotification/${CSGOtmAPI.formatItem(item, '/')}`;
        price = parseInt(price);
        url = `${url}/${String(price)}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * -------------------------------------
     * Searching methods
     * -------------------------------------
     */

    /**
     * Searching items by names
     *
     * @param {Array|Object} items One item or array of items with market_hash_name properties
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    searchItemsByName(items, gotOptions = {}) {
        if (!Object.keys(gotOptions).length) {
            gotOptions = clone(this.options.defaultGotOptions);
        }
        else {
            gotOptions = clone(gotOptions);
        }

        if (!Array.isArray(items)) {
            items = [items];
        }

        let list = [];
        items.forEach(item => {
            item = item || {};
            list.push(item.market_hash_name);
        });

        gotOptions.body = {
            list
        };

        return this.callMethodWithKey('MassSearchItemByName', gotOptions);
    }

    /**
     * Searching one item by hash name
     *
     * @param {Object|String} item Item object that you got from API or created by yourself, or just item market hash name
     * @property {String} item.market_hash_name Item market hash name
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    searchItemByName(item, gotOptions = {}) {
        let mhn = typeof item === 'string' ? item : item.market_hash_name;
        let url = `SearchItemByName/${mhn}`;

        return this.callMethodWithKey(url, gotOptions);
    }

    /**
     * -------------------------------------
     * Quick buy methods
     * -------------------------------------
     */

    /**
     * Getting list of available items for quick buy
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    quickGetItems(gotOptions = {}) {
        return this.callMethodWithKey('QuickItems', gotOptions);
    }

    /**
     * Quick buy item
     *
     * @param {String} itemId Item ui_id from 'accountGetTrades' method
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    quickBuy(itemId, gotOptions = {}) {
        return this.callMethodWithKey(`QuickBuy/${String(itemId)}`, gotOptions);
    }

    /**
     * -------------------------------------
     * Additional methods
     * -------------------------------------
     */

    /**
     * Getting all stickers
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    additionalGetStickers(gotOptions = {}) {
        return this.callMethodWithKey('GetStickers', gotOptions);
    }

    /**
     * Test trades possibility
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    additionalTest(gotOptions = {}) {
        return this.callMethodWithKey('Test', gotOptions);
    }

    /**
     * Getting the last messages
     *
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    additionalGetChatLog(gotOptions = {}) {
        return this.callMethodWithKey('GetChatLog', gotOptions);
    }

    /**
     * Getting the status of bot
     *
     * @param {String} botId Bot ui_bid from 'accountGetTrades' method
     * @param {Object} [gotOptions] Options for 'got' module
     *
     * @returns {Promise}
     */
    additionalCheckBotStatus(botId, gotOptions = {}) {
        return this.callMethodWithKey(`CheckBotStatus/${String(botId)}`, gotOptions);
    }
}

export {CSGOtmAPI as API};
export {CSGOtmAPIError};

