/**
 * Make your scraper
 *
 * @module  captainscraper/modules/Scraper
 * @class   Scraper
 * @extends Module
 *
 * @requires request
 * @requires iconv
 * @requires colors
 * @requires cheerio
 */

declare var process;
declare function require( name:string );

import { Parameters } from '../../framework/Configuration/Configuration';
import { Config } from '../../framework/Configuration/Configuration';
import { Module } from '../../framework/Module/Module';
import { Database } from '../../modules/Database/Database';
import { Controller } from '../../framework/Controller/Controller';
import { ManagerDatabase } from '../../framework/Manager/ManagerDatabase';
import { Parser } from './Parser/Parser';

let request: any       = require( Parameters.dir.modules + '/request' );
let iconv: any         = require( Parameters.dir.modules + '/iconv-lite' );
let colors: any        = require( Parameters.dir.modules + '/colors' );
let cheerio: any       = require( Parameters.dir.modules + '/cheerio' );

class Scraper extends Module {

    static currentId: number = 0;

    private manager: ManagerDatabase = null;

    public param: any = {
        maxLoadingPages : 3,
        maxPagesInRam   : 200,
        frequency       : 100,
        auto            : true,
        log             : Config.logs.scraper,
        timeout         : 20000,

        urlFail         : {},
        maxFailPerPage  : 3,

        basicAuth       : false,
        websiteDomain   : 'http://xxx.xx'
    };

    public moduleName: string = 'Scraper';
    public scraperId: number;

    private data: any = {
        urlFail : {}
    };

    constructor( controller: Controller ) {

        super( controller );

        Scraper.currentId++;

        this.scraperId = Scraper.currentId;

    }

    /* Usage */

    public addPage( parameters: any ): void {

        let url: string        = parameters.url || this.param.websiteDomain;
        let header: any        = parameters.header || {};
        let param: any         = parameters.param || {};
        let parser: any        = parameters.parser;
        let noDoublon: boolean = parameters.noDoublon || false;
        let database: Database = <Database>this.controller.get('Database');

        /* Pas d'url */
        if( !parameters.hasOwnProperty( 'url' ) ) {
            this.log( 'Error addPage : URL NOT DEFINED', 'red' );

            return;
        }

        /* Url relatif */
        if( url.charAt(0) === '/' && url.charAt(1) !== '/' ) {
            url = this.param.websiteDomain + url;
        }

        /* Basic authentification */
        if( this.param.basicAuth ) {
            url = url.replace( '://', '://' + this.param.basicAuth + '@' );
        }

        /* Si le parser n'est pas dans la liste on l'ajoute */
        if( !Parser.get( this.scraperId, parser.name ) ) {
            new ( parser )( this );
        }

        if( noDoublon ) {
            database.upsert(
                'scraper',
                {
                    url   : url,
                    param : param
                },
                {
                    url      : url,
                    parser   : parser.name,
                    header   : header,
                    param    : param
                }
            );
        } else {
            database.insert(
                'scraper',
                {
                    url      : url,
                    parser   : parser.name,
                    header   : header,
                    param    : param
                }
            );
        }

        if( this.manager === null ) {
            this.createCrawler();
        }

        if( this.param.auto && ( this.manager.getState() === 'end' || this.manager.getState() === 'neverStart' ) ) {
            this.startCrawler();
        }

        this.manager.increaseDataWaitingElements();

    }

    /* Private */

    public loadPage( url: string, callback: Function, header: any ): void {

        let self: any = this;

        self.log( 'LOADING PAGE : ' + url );

        self.manager.increaseDataNbInstances();

        let options: any = {
            url               : url,
            headers           : {
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/43.0.2357.130 Safari/537.36'
            },
            timeout           : self.param.timeout,
            rejectUnauthorized: false
        };

        if( !( typeof header === 'undefined' ) ) {
            let key: string;
            for( key in header ) {
                options.headers[ key ] = header[ key ];
            }
        }

        if( self.param.encodage ) {
            options.encoding = null;
        }

        request(
            options,
            function (error, response, body) {
                self.manager.decreaseDataNbInstances();
                self.manager.increaseDataTotalExec();
                self.manager.decreaseDataWaitingElements();

                if( !error ) {
                    if( self.param.encodage ) {
                        body = iconv.decode( new Buffer(body), self.param.encodage );
                    }

                    let headers: any = {};

                    if( typeof response !== 'undefined' && response.hasOwnProperty( 'headers' ) ) {
                        headers = response.headers;
                    }

                    callback( body, headers );
                } else {
                    self.log( 'Error : ' + error, 'red' );

                    if( !this.param.urlFail.hasOwnProperty( url ) || this.param.urlFail[ url ] < self.param.maxFailPerPage ) {
                        if( !this.param.urlFail.hasOwnProperty( url ) ) {
                            this.param.urlFail[ url ] = 1;
                        } else {
                            this.param.urlFail[ url ]++;
                        }

                        self.loadPage( url, callback, header );
                    } else {
                        callback( '', {} );
                    }
                }
            }
        );

    }

    public createCrawler(): void {

        let self: any = this;

        let main: Function = function( page ) {
            self.loadPage(
                page.url,
                function( data, headers ) {
                    let parameters: any = {
                        url    : page.url,
                        header : headers,
                        body   : data,
                        other  : page.param
                    };

                    try {
                        Parser.get( self.scraperId, page.parser ).readContent( data, parameters );
                    } catch( e ) {
                        self.log( 'Parsing error! ' + page.parser + ' : ' + e, 'red' );
                    }
                },
                page.header
            );
        };

        let otherCondition: Function = function() {
            return true;
        };

        let sleepCondition: Function = function() {
            return false;
        };

        let parameters: any = {
            id             : 'SCRAPER',
            maxInstance    : self.param.maxLoadingPages,
            frequency      : self.param.frequency,
            main           : main,
            otherCondition : otherCondition,
            sleepCondition : sleepCondition,
            specificParam  : {
                collection : 'scraper'
            }
        };

        self.manager = new ManagerDatabase( self, parameters );

    }

    public startCrawler(): void {

        if( this.manager === null ) {
            this.createCrawler();
        }

        this.manager.data.isLastRequestEmpty = false;

        this.manager.start();

    }

    /* Others */

    public log( message, color = 'blue' ): void {

        if( this.param.log || color === 'red' ) console.log( '[' + this.controller.name + '] ' + ( message )[color] );

    }

}

export { Scraper };