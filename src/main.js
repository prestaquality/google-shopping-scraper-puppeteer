const Apify = require('apify');

const { log, sleep } = Apify.utils;

const {
    checkAndEval,
    applyFunction,
    makeRequestList
} = require('./utils');


Apify.main(async () => {
    const input = await Apify.getValue('INPUT');

    // Validate the input
    if (!input) throw new Error('Missing configuration');

    const {
        queries = null,
        inputUrl = null,
        countryCode = 'us',
        maxPostCount,
        isAdvancedResults,
        extendOutputFunction = null,
    } = input;

    if (!(queries && countryCode) && !inputUrl) {
        throw new Error('At least "Search Queries & countryCode" or "Input URL" must be provided');
    }

    // Prepare the initial list of google shopping queries and request queue
    const requestList = await makeRequestList(queries, inputUrl, countryCode);
    log.info('Search URLs:');
    requestList.requests.forEach(r => console.log('  ', r.url));

    const requestQueue = await Apify.openRequestQueue();

    // if exists, evaluate extendOutputFunction
    let evaledFunc;
    if (extendOutputFunction) evaledFunc = checkAndEval(extendOutputFunction);

    const proxyConfiguration = await Apify.createProxyConfiguration({
        groups: ['GOOGLE_SERP'],
    });

    // crawler config
    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,
        maxRequestRetries: 3,
        handlePageTimeoutSecs: 240,
        maxConcurrency: 20,
        proxyConfiguration,
        launchContext: {
            launchOptions: {
                waitUntil: 'load',
            },
            useChrome: true,
            stealth: true,
        },
        preNavigationHooks: [async ({}, gotoOptions) => { 
            gotoOptions.waitUntil = 'load';
            gotoOptions.timeout = 18000;
          }],
        handlePageFunction: async ({ page, request, response, puppeteerPool, autoscaledPool, session, proxyInfo }) => {
            log.info('Processing: ' + request.url);
            const { label, query, hostname } = request.userData;

            if (label === 'SEARCH-PAGE') {
                try {
                    await page.waitForSelector('div.sh-pr__product-results');
                } catch (e) {
                    const html = await page.content();
                    await Apify.setValue(`ERROR-PAGE-${Math.random()}`, html, { contentType: 'text/html' });
                    throw `Page didn't load properly, retrying...`;
                }
                const resultsLength = await page.evaluate(() => {
                    return document.querySelector('div.sh-pr__product-results').children.length;
                });

                log.info(`Processing "${query}" - found ${resultsLength} products`);

                // check HTML if page has no results
                if (resultsLength === 0) {
                    log.warning('The page has no results. Check dataset for more info.');

                    await Apify.pushData({
                        '#debug': Apify.utils.createRequestDebugInfo(request),
                    });
                }
                const data = await page.evaluate((maxPostCount, query) => {
                    let results = Array.from(document.querySelectorAll('.sh-dlr__list-result'));
                    // limit the results to be scraped, if maxPostCount exists
                    if (maxPostCount) {
                        results = results.slice(0, maxPostCount);
                    }

                    const data = [];

                    for (let i = 0; i < results.length; i++) {
                        // Please pay attention that "merchantMetrics" and "reviewsLink" were removed from the  "SEARCH" page.
                        const item = results[i];

                        const title = item.querySelector('h3');
                        const productName = title ? title.textContent : null;

                        const productLinkAnchor = item.querySelector('a[href*="shopping/product/"]');
                        const productLink = productLinkAnchor ? productLinkAnchor.href : null;
                        const price = item.querySelector('div[data-sh-or="price"] div > span > span')
                        ? item.querySelector('div[data-sh-or="price"] div > span > span').textContent : null;

                        let description = ""; //item.querySelectorAll('div.hBUZL')[1].textContent;

                        const merchantName = item.querySelector('div[data-sh-or="price"]').nextSibling ? item.querySelector('div[data-sh-or="price"]').nextSibling.textContent : null;

                        // const merchantMetricsAnchor = item.querySelector('a[href*="shopping/ratings/account/metrics"]');
                        // let merchantMetrics = merchantMetricsAnchor ? merchantMetricsAnchor.textContent : '';

                        let merchantLink = item.querySelector('div[data-sh-or="price"]').parentElement.parentElement.href;

                        const idArray = productLink ? productLink.split('?')[0].split('/') : null;
                        let shoppingId = idArray ? idArray[idArray.length - 1] : null;

                        // let reviewsLink = reviewsElement ? reviewsElement.href : null;
                        let reviewsScore = item.querySelector('div[aria-label*="product reviews"]') ? item.querySelector('div[aria-label*="product reviews"] span').textContent : null;
                        let reviewsCount = item.querySelector('div[aria-label*="product reviews"]') ? item.querySelector('div[aria-label*="product reviews"]').getAttribute('aria-label').split(' ')[0] : null;

                        let detailsUrl = item.querySelector('a.CaGdPb.ixf2Ic') ? item.querySelector('a.CaGdPb.ixf2Ic').getAttribute('href') : null;
                        if(detailsUrl != null){
                            var queue = Apify.openRequestQueue();
                            queue.addRequest(makeRequestList(null, [detailsUrl], 'es', true)); //TODO poner la region
                        }
                        
                        const output = {
                            query,
                            productName,
                            productLink,
                            price,
                            description,
                            merchantName,
                            // merchantMetrics,
                            merchantLink,
                            shoppingId,
                            // reviewsLink, 
                            reviewsScore,
                            reviewsCount,
                            positionOnSearchPage: i + 1,
                            productDetails: '',//item.querySelectorAll('.translate-content')[1].textContent.trim(),
                        };

                        data.push(output);
                    }

                    return data;
                }, maxPostCount, query);

                for (let i = 0; i < data.length; i++) {
                    let item = data[i];

                    // if basic item, re-initialize item object with relevant props
                    if (!isAdvancedResults) {
                        item = {
                            idArray: item.idArray,
                            shoppingId: item.shoppingId,
                            productName: item.productName,
                            description: item.description,
                            merchantMetrics: item.merchantMetrics,
                            seller: {
                                sellerName: item.merchantName,
                                sellerLink: item.merchantLink,
                                sellerPrice: item.price
                            },
                            price: item.price,
                            merchantLink: item.merchantLink
                        }
                    }


                    if (evaledFunc) {
                        item = await applyFunction(page, evaledFunc, item);
                    }

                    await Apify.pushData(item);
                    log.info(`${item.productName} item pushed.`);
                }
            }

             if (label === 'DETAIL_PAGE') {
                 log.info('Processing detail-page: ' + request.url);
                 const { label, query, hostname, item } = request.userData;
                 console.log(response, puppeteerPool, autoscaledPool, session, proxyInfo);

                 // await page.waitForSelector('table');
                 const data = await page.evaluate(() => {
                     const data = [];

                     const sellerTable = document.querySelector('table');

                     const tbody = sellerTable.querySelector('tbody');
                     const trs = Array.from(tbody.children);

                     for (let i = 0; trs.length; i++) {
                         const tr = trs[i];
                         tds = Array.from(tr.children);

                         currentSeller = Object.create(null);

                         for (let z = 0; tds.length; z++) {
                             if (z === 0) {
                                 td = tds[z];
                                 currentSeller.sellerName = td.innerText.split('\n')[0];
                                 currentSeller.sellerLink = td.querySelector('a').href;
                             }

                             if (z === 2) {
                                 td = tds[z];
                                 currentSeller.sellerPrice = td.innerText;
                             }
                         }

                         data.push(currentSeller);
                     }

                     return data;
                 });

                 item.sellers = data;

                 Apify.pushData(item);
                 console.log('item with sellers pushed.');
             }
        },

        handleFailedRequestFunction: async ({ request }) => {
            log.warning(`Request ${request.url} failed too many times`);

            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
    });

    log.info('Starting crawler.');
    await crawler.run();

    log.info('Crawler Finished.');
});
