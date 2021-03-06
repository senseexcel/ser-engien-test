//#region IMPORTS
import { readdir, readFile, PathLike } from "fs";
import { Logger, ELoglevel, ETransportType } from "../../node_modules/letslog/src/index";
import { ISerConfig } from "../../node_modules/ser.api/index";
import { TestModel } from "./TestModel";
import { IConfig } from "./interfaces/IConfig";
import { DockerController } from "./DockerController";
import { ResultModel, ITestError, ITestResult } from "./ResultModel";
import { delay } from "../lib/utils";
import { getFiles, removeAllFilesInFolder } from "../lib/fileUtils";
import { CompareModel } from "./CompareModel";

let config: IConfig = require("../../config.json");
//#endregion

export class TestController {

    //#region VARIABLES
    private logger: Logger = null;
    private results: ResultModel[] = [];
    private rootPath = config.testPath;
    //#endregion

    constructor() {
        let logPath: string;
        if (process.env.appdata) {
            logPath = config.logPath?config.logPath:"%appdata%/tf_log/ReportingTestTool"
        } else {
            logPath = config.logPath?config.logPath:"/var/log"
        }

        this.logger = new Logger({
            loglvl: ELoglevel[config.loglevel],
            transports: [{
                baseComment: "TestController",
                showLoglevel: true,
                type: ETransportType.console
            }, {
                baseComment: "TestController",
                logFileName: "log",
                logpath: logPath,
                type: ETransportType.filesystem,
                showBaseComment: true,
                showDate: true,
                showLoglevel: true
            }]
        })
    }

    //#region PRIVATE FUNCTIONS

    private async getAvailableTests(rootPath: PathLike): Promise<string[]> {
        this.logger.trace("in getAvailableTests");
        try {
            const availableTests = await getFiles(rootPath);
            if (typeof (config.tests) === "undefined" || config.tests.length === 0) {
                return availableTests;
            }
            const relevantTests = availableTests.filter((current) => {

                let res = false;

                for (const test of config.tests) {
                    if (test.substr(0, 2) === current.substr(0,2)) {
                        res = true;
                    }
                }

                return res;
            })
            return relevantTests;
        } catch (error) {
            this.logger.error(error);
            return [];
        }
    }

    private async getJobJson(path: PathLike): Promise<ISerConfig> {
        this.logger.trace("in getJobJson");
        return new Promise<ISerConfig>((resolve, reject) => {
            readFile(path, { encoding: "utf8" }, (err, fileContent) => {
                if (err) {
                    this.logger.error(err)
                    reject(err);
                }
                try {
                    resolve(JSON.parse(fileContent));
                } catch (error) {
                    error = new Error("json parse Error")
                    reject(error);
                }
            });
        });
    }

    private async getQlikApplicationFiles(test: string): Promise<string[]> {
        this.logger.trace("in getQlikApplicationFiles");
        let qvfFiles: string[] = [];
        try {
            let arr = await (() => {
                return new Promise<string[]>(async (resolve, reject) => {
                    let filesArr = []
                    readdir(`${this.rootPath}/${test}`, (err, files) => {
                        if (err) {
                            this.logger.error(err)
                            reject(err);
                        }
                        for (const file of files) {
                            if (file.indexOf("\.qvf") > -1) {
                                filesArr.push(`${this.rootPath}${test}/${file}`);
                            }
                        }
                        resolve(filesArr);
                    })
                });
            })()
            qvfFiles = qvfFiles.concat(arr);
        } catch (error) {
            this.logger.error(error);
            return [];
        }
        return qvfFiles;
    }

    private async runTest(testName: string, port: number): Promise<ResultModel> {
        this.logger.trace("in runTest");
        const resultModel = new ResultModel(testName);

        try {
            const files = await getFiles(`${this.rootPath}${testName}`);
            const jobFiles = files.filter(file => file.indexOf("json") >= 0);

            await Promise.all(
                jobFiles.map(async (jobFile) => {
                    const jobJson = await this.getJobJson(`${this.rootPath}${testName}/${jobFile}`);
                    const testModel = new TestModel(testName, jobJson, resultModel);
                    await testModel.run(port);

                    const compareModel = new CompareModel(testName, "csv", resultModel);
                    await compareModel.run();

                    return;
                })
            );
            return resultModel;

        } catch (error) {
            this.logger.error(error);
            const resultObject: ITestResult = {
                name: "Generall"
            }
            resultModel.addResult(resultObject);
            const errorObject: ITestError = {
                msg: error,
                name: "run test error",
                occurence: "TestController - runTest"
            }
            resultModel.addError(errorObject);
            return resultModel;
        }
    }

    private async run(basePort: number, name: string): Promise<ResultModel[]> {

        this.logger.trace("in run");
        await removeAllFilesInFolder(`${this.rootPath}${name}/output`);
        const port = basePort;
        let result: ResultModel[] = [];
        const dockerController: DockerController = new DockerController(`${this.rootPath}${name}`);
        const successInit = await dockerController.init();
        this.logger.info("running test: ", name);

        if (!successInit) {
            throw "Error while building Enviroment";
        }


        try {

            const qvfFiles = await this.getQlikApplicationFiles(name);
            let successfullyCreatedEnv = await dockerController.createEnviroment(port, qvfFiles);
            await delay(10000);

            if (successfullyCreatedEnv) {
                this.logger.trace("qvf's uploaded to docker container");
                let res = await this.runTest(name, port);
                this.logger.info(res.getResults())
                result.push(res);
            }

            try {
                await delay(1000);
                await dockerController.copyLogFile();
            } catch (error) {
                this.logger.error("copy of log faild", error);
            }

            this.logger.trace("after copy log");
            this.logger.trace("property value of removeDockerEnviroment: ", config.removeDockerEnviroment);

            if (config.removeDockerEnviroment) {
                await dockerController.clearEnviroment();
            }

            return result;

        } catch (error) {
            if (config.removeDockerEnviroment) {
                await dockerController.clearEnviroment();
            }
            throw error;
            ;
        }
    }

    //#endregion

    //#region PUBLIC FUNCTIONS

    public async startTest() {
        this.logger.trace("in startTest");
        if (!config.removeDockerEnviroment) {
            this.logger.warn("docker enviroment will not be removed!!!");
        }

        let interval;
        (async () => {
            interval = setInterval(() => {
                this.logger.info("in progress ...");
            }, 2000);
        })();

        let availableTests = await this.getAvailableTests(this.rootPath);
        this.logger.info(`${availableTests.length} tests found`);

        try {
            let basePort: number = config.reportingEngineStartPort;

            if (!config.runParallel) {

                this.logger.trace("### run sync ###");
                await (async () => {
                    for (const testName of availableTests) {
                        this.results = this.results.concat(await this.run(basePort++, testName));
                    }
                })();

            } else {

                this.logger.trace("### run async ###");
                let a = await Promise.all(
                    availableTests.map(async (testName) => {
                        return await this.run(basePort++, testName);
                    })
                )
                this.results = a.reduce((current, next) => current.concat(next), []);

            }

            this.logger.info("");
            this.logger.info("");
            this.logger.info("###################################################");
            this.logger.info("##                                               ##");
            this.logger.info("##                    RESULTS                    ##");
            this.logger.info("##                                               ##");
            this.logger.info("##                     ##        .               ##");
            this.logger.info("##               ## ## ##       ==               ##");
            this.logger.info("##            ## ## ## ##      ===               ##");
            this.logger.info('##         /""""""""""""""""\\___/ ===            ##');
            this.logger.info("##    ~~~ {~~ ~~~~ ~~~ ~~~~ ~~ ~ /  ===- ~~~     ##");
            this.logger.info("##         \\______ o          __/                ##");
            this.logger.info("##          \\    \\        __/                    ##");
            this.logger.info("##           \\____\\______/                       ##");
            this.logger.info("##                                               ##");
            this.logger.info("###################################################");
            this.logger.info("");
            this.logger.info("");

            for (const result of this.results) {
                this.logger.info(result.getResults());
            }

            clearInterval(interval);
            this.logger.info("test finished");


        } catch (error) {
            this.logger.error("error", error);
            clearInterval(interval);
            this.logger.info("test finished");
        }

        return;
    }

    //#endregion
}
