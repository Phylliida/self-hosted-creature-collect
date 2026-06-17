/**
 * @author Bert Baron
 */
import * as fxp from './fxp.js'
import {WorkerContext} from "./workerContext.js";
import {MandelbrotFloat} from "./mandelbrotFloat.js";
import {MandelbrotFxP} from "./mandelbrotFxP.js";
import {MandelbrotPerturbation} from "./mandelbrotPerturbation.js";
import {MandelbrotPerturbationExtFloat} from "./mandelbrotPerturbationExtFloat.js";
import {MandelbrotMirage} from "./mandelbrotMirage.js";
import {MandelbrotMiragePerturbation} from "./mandelbrotMiragePerturbation.js";
import {MandelbrotBurningShip} from "./mandelbrotBurningShip.js";
import {MandelbrotBurningShipPerturbation} from "./mandelbrotBurningShipPerturbation.js";
import {MandelbrotTricorn} from "./mandelbrotTricorn.js";
import {MandelbrotTricornPerturbation} from "./mandelbrotTricornPerturbation.js";
import {MandelbrotMultibrot} from "./mandelbrotMultibrot.js";
import {MandelbrotMultibrotPerturbation} from "./mandelbrotMultibrotPerturbation.js";
import {MandelbrotPhoenix} from "./mandelbrotPhoenix.js";
import {MandelbrotPhoenixPerturbation} from "./mandelbrotPhoenixPerturbation.js";
import {MandelbrotAbsFamily} from "./mandelbrotAbsFamily.js";
import {MandelbrotGyre} from "./mandelbrotGyre.js";
import {MandelbrotGyrePerturbation} from "./mandelbrotGyrePerturbation.js";
import {MandelbrotLyra} from "./mandelbrotLyra.js";
import {MandelbrotKali} from "./mandelbrotKali.js";
import {MandelbrotKaliPerturbation} from "./mandelbrotKaliPerturbation.js";
import {MandelbrotAbsFamilyPerturbation} from "./mandelbrotAbsFamilyPerturbation.js";
import {MandelbrotWebGPU} from "./mandelbrotWebGPU.js";

const ctx = new WorkerContext()

async function initMandelbrotFloat() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotFloat(ctx)
}

async function initMandelbrotFxP() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotFxP(ctx)
}

async function initMandelbrotPerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotPerturbation(ctx)
}

async function initMandelbrotPerturbationExtFloat() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotPerturbationExtFloat(ctx)
}

async function initMandelbrotMirage() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotMirage(ctx)
}

async function initMandelbrotMiragePerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotMiragePerturbation(ctx)
}

async function initMandelbrotBurningShip() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotBurningShip(ctx)
}

async function initMandelbrotBurningShipPerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotBurningShipPerturbation(ctx)
}

async function initMandelbrotTricorn() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotTricorn(ctx)
}

async function initMandelbrotTricornPerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotTricornPerturbation(ctx)
}

async function initMandelbrotMultibrot() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotMultibrot(ctx)
}

async function initMandelbrotMultibrotPerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotMultibrotPerturbation(ctx)
}

async function initMandelbrotPhoenix() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotPhoenix(ctx)
}

async function initMandelbrotPhoenixPerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotPhoenixPerturbation(ctx)
}

async function initMandelbrotGyre() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotGyre(ctx)
}

async function initMandelbrotGyrePerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotGyrePerturbation(ctx)
}

async function initMandelbrotLyra() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotLyra(ctx)
}

async function initMandelbrotKali() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotKali(ctx)
}

async function initMandelbrotKaliPerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotKaliPerturbation(ctx)
}

async function initMandelbrotAbsFamily() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotAbsFamily(ctx)
}

async function initMandelbrotAbsFamilyPerturbation() {
    await new Promise(resolve => setTimeout(resolve, 1))
    return new MandelbrotAbsFamilyPerturbation(ctx)
}

const mandelbrotFloat = initMandelbrotFloat();
const mandelbrotFxP = initMandelbrotFxP();
const mandelbrotPerturbation = initMandelbrotPerturbation();
const mandelbrotPerturbationExtFloat = initMandelbrotPerturbationExtFloat();
const mandelbrotMirage = initMandelbrotMirage();
const mandelbrotMiragePerturbation = initMandelbrotMiragePerturbation();
const mandelbrotBurningShip = initMandelbrotBurningShip();
const mandelbrotBurningShipPerturbation = initMandelbrotBurningShipPerturbation();
const mandelbrotTricorn = initMandelbrotTricorn();
const mandelbrotTricornPerturbation = initMandelbrotTricornPerturbation();
const mandelbrotMultibrot = initMandelbrotMultibrot();
const mandelbrotMultibrotPerturbation = initMandelbrotMultibrotPerturbation();
const mandelbrotPhoenix = initMandelbrotPhoenix();
const mandelbrotPhoenixPerturbation = initMandelbrotPhoenixPerturbation();
const mandelbrotAbsFamily = initMandelbrotAbsFamily();
const mandelbrotGyre = initMandelbrotGyre();
const mandelbrotGyrePerturbation = initMandelbrotGyrePerturbation();
const mandelbrotLyra = initMandelbrotLyra();
const mandelbrotKali = initMandelbrotKali();
const mandelbrotKaliPerturbation = initMandelbrotKaliPerturbation();
const mandelbrotAbsFamilyPerturbation = initMandelbrotAbsFamilyPerturbation();

onmessage = handleMessage

// Add some randomnes to have different checkpoints per worker
const STOP_CHECK_INTERVAL = 200 + Math.floor(Math.random() * 100)

async function handleMessage(msg) {
    const message = parseMessage(msg)
    // console.log(`Received: ${JSON.stringify(msg.data)}`)

    if (message.type === 'task') {
        const implPromise =
            message.fractal === 'mirage'
                ? (message.requiredPrecision > 58 ? mandelbrotMiragePerturbation : mandelbrotMirage)
                : message.fractal === 'burningship'
                    ? (message.requiredPrecision > 58 ? mandelbrotBurningShipPerturbation : mandelbrotBurningShip)
                    : message.fractal === 'tricorn'
                        ? (message.requiredPrecision > 58 ? mandelbrotTricornPerturbation : mandelbrotTricorn)
                        : message.fractal === 'multibrot'
                            ? (message.requiredPrecision > 58 ? mandelbrotMultibrotPerturbation : mandelbrotMultibrot)
                            : message.fractal === 'phoenix'
                                ? (message.requiredPrecision > 58 ? mandelbrotPhoenixPerturbation : mandelbrotPhoenix)
                                : message.fractal === 'absfamily'
                                    ? (message.requiredPrecision > 58 ? mandelbrotAbsFamilyPerturbation : mandelbrotAbsFamily)
                                    : message.fractal === 'gyre'
                                        ? (message.requiredPrecision > 58 ? mandelbrotGyrePerturbation : mandelbrotGyre)
                                    : message.fractal === 'lyra'
                                        ? mandelbrotLyra
                                    : message.fractal === 'kali'
                                        ? (message.requiredPrecision > 58 ? mandelbrotKaliPerturbation : mandelbrotKali)
                                    : message.requiredPrecision > 1020 && !message.julia // the extended float algorithm has no julia support
                                    ? mandelbrotPerturbationExtFloat
                                    : message.requiredPrecision > 58
                                        ? mandelbrotPerturbation
                                        : mandelbrotFloat

        const impl = await implPromise
        // console.log(`Precision ${message.requiredPrecision}, using ${impl.constructor.name}`)


        ctx.initTask(message.jobToken)
        ctx.resetStats()
        const result = await impl.process(message)
        // Transfer the pixel buffers instead of copying them, they are not used here anymore
        const transfer = [result.values.buffer]
        if (result.smooth) {
            transfer.push(result.smooth.buffer)
        }
        postMessage(result, transfer)
    }
}

function parseMessage(msg) {
    if (msg.data.type === 'task') {
        msg.data.frameTopLeft[0] = fxp.fromJSON(msg.data.frameTopLeft[0])
        msg.data.frameTopLeft[1] = fxp.fromJSON(msg.data.frameTopLeft[1])
        msg.data.frameBottomRight[0] = fxp.fromJSON(msg.data.frameBottomRight[0])
        msg.data.frameBottomRight[1] = fxp.fromJSON(msg.data.frameBottomRight[1])
        if (msg.data.juliaSeed) {
            msg.data.juliaSeed = msg.data.juliaSeed.map(fxp.fromJSON)
        }
    }
    return msg.data
}
