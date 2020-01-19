const redis = require('redis'),
  winston = require('winston'),
  dataKind = require('./versioned_data_kind'),
  fs = require('fs'),
  path = require('path'),
  CachingStoreWrapper = require('./caching_store_wrapper');

const noop = function(){};


function RedisFeatureStore(redisOpts, cacheTTL, prefix, logger, preconfiguredClient) {
  return new CachingStoreWrapper(new redisFeatureStoreInternal(redisOpts, prefix, logger, preconfiguredClient), cacheTTL);
}

function redisFeatureStoreInternal(redisOpts, prefix, logger, preconfiguredClient) {

  const client = preconfiguredClient || redisOpts.client || redis.createClient(redisOpts),
    store = {},
    itemsPrefix = (prefix || 'launchdarkly') + ':',
    initedKey = itemsPrefix + '$inited';

  logger = (logger ||
    new winston.Logger({
      level: 'info',
      transports: [
        new (winston.transports.Console)(),
      ]
    })
  );

  let connected = !!redisOpts.client;
  let initialConnect = !redisOpts.client;
  client.on('error', err => {
    // Note that we *must* have an error listener or else any connection error will trigger an
    // uncaught exception.
    logger.error('Redis error - ' + err);
  });
  client.on('reconnecting', info => {
    logger.info('Attempting to reconnect to Redis (attempt #' + info.attempt +
      ', delay: ' + info.delay + 'ms)');
  });
  client.on('connect', () => {
    if (!initialConnect) {
      logger.warn('Reconnected to Redis');
    }
    initialConnect = false;
    connected = true;
  });
  client.on('end', () => {
    connected = false;
  });

  if (!redisOpts.client) {
    // Allow driver programs to exit, even if the Redis socket is active
    client.unref();
  }

  function itemsKey(kind) {
    return itemsPrefix + kind.namespace;
  }

  // A helper that performs a get with the redis client
  function doGet(kind, key, cb) {
    cb = cb || noop;

    if (!connected) {
      logger.warn('Attempted to fetch key ' + key + ' while Redis connection is down');
      cb(null);
      return;
    }

    client.hget(itemsKey(kind), key, (err, obj) => {
      if (err) {
        logger.error('Error fetching key ' + key + ' from Redis in \'' + kind.namespace + '\'', err);
        cb(null);
      } else {
        const item = JSON.parse(obj);
        cb(item);
      }
    });
  }

  store.getInternal = (kind, key, cb) => {
    cb = cb || noop;
    doGet(kind, key, item => {
      if (item && !item.deleted) {
        cb(item);
      } else {
        cb(null);
      }
    });
  };

  store.getAllInternal = (kind, cb) => {
    cb = cb || noop;
    if (!connected) {
        // modify the default behaviour to work against file
        logger.warn('Attempted to fetch all keys while Redis connection is down');
        const filePath = path.join(__dirname, 'features.json');
        fs.readFile(filePath, { encoding: 'utf-8' }, function (err, obj) {
            if (!err) {
                const results = {},
                    items = obj;

                for (let key in items) {
                    if (Object.hasOwnProperty.call(items, key)) {
                        results[key] = JSON.parse(items[key]);
                    }
                }
                cb(results);
            } else {
                console.log(err);
                cb(null);
            }
        });
    }

    client.hgetall(itemsKey(kind), (err, obj) => {
      if (err) {
        logger.error('Error fetching \'' + kind.namespace + '\' from Redis', err);
        cb(null);
      } else {
        const results = {},
          items = obj;

        for (let key in items) {
          if (Object.hasOwnProperty.call(items, key)) {
            results[key] = JSON.parse(items[key]);
          }
        }
        cb(results);
      }
    });
  };

  store.initInternal = (allData, cb) => {
    const multi = client.multi();

    for (let kindNamespace in allData) {
      if (Object.hasOwnProperty.call(allData, kindNamespace)) {
        const kind = dataKind[kindNamespace];
        const baseKey = itemsKey(kind);
        const items = allData[kindNamespace];
        const stringified = {};
        multi.del(baseKey);
        for (let key in items) {
          if (Object.hasOwnProperty.call(items, key)) {
            stringified[key] = JSON.stringify(items[key]);
          }
        }
        // Redis does not allow hmset() with an empty object
        if (Object.keys(stringified).length > 0) {
          multi.hmset(baseKey, stringified);
        }
      }
    }

    multi.set(initedKey, '');

    multi.exec(err => {
      if (err) {
        logger.error('Error initializing Redis store', err);
      }
      cb();
    });
  };

  store.upsertInternal = (kind, item, cb) => {
    updateItemWithVersioning(kind, item, (err, attemptedWrite) => {
      if (err) {
        logger.error('Error upserting key ' + item.key + ' in \'' + kind.namespace + '\'', err);
      }
      cb(err, attemptedWrite);
    });
  };

  function updateItemWithVersioning(kind, newItem, cb) {
    client.watch(itemsKey(kind));
    const multi = client.multi();
    // testUpdateHook is instrumentation, used only by the unit tests
    const prepare = store.testUpdateHook || function(prepareCb) { prepareCb(); };
    prepare(() => {
      doGet(kind, newItem.key, oldItem => {
        if (oldItem && oldItem.version >= newItem.version) {
          multi.discard();
          cb(null, oldItem);
        } else {
          multi.hset(itemsKey(kind), newItem.key, JSON.stringify(newItem));
          multi.exec((err, replies) => {
            if (!err && replies === null) {
              // This means the EXEC failed because someone modified the watched key
              logger.debug('Concurrent modification detected, retrying');
              updateItemWithVersioning(kind, newItem, cb);
            } else {
              cb(err, newItem);
            }
          });
        }
      });
    });
  }

  store.initializedInternal = cb => {
    cb = cb || noop;
    client.exists(initedKey, function(err, obj) {
      cb(Boolean(!err && obj));
    });
  };

  store.close = () => {
    client.quit();
  };

  return store;
}

module.exports = RedisFeatureStore;
