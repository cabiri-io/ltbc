type LambdaRule<T extends PromiseFunction> = {
  type: "lambda"
  // we would ideally add some randomness to this
  delay?: number
  every?: number
  error?: (...t: Parameters<T>) => Error | any
  result?: (
    ...t: Parameters<T>
  ) => Promise<PromiseReturnType<T>> | PromiseReturnType<T>
}

// SocketHangUp
// DNS
// Http Response Code
type FailReason = {
  type:
    | "CLIENT_SOCKET_HANG_UP" // client was waiting for a long time for response and gave up
    | "SERVER_SOCKET_HANG_UP" // server took a long time to respond and client hangs up
    | "HTTP_RESPONSE_CODE"
  value: number
}

type RequestRule = {
  host?: string
  href?: string
  type: "http"
  every?: number
  delay?: {
    value: number
    range?: number
  }
  fail?: {
    reason: FailReason
  }
}

type Rule<T extends PromiseFunction> = RequestRule | LambdaRule<T>

type Experiment<T extends PromiseFunction> = {
  name: string
  rules: Array<LambdaRule<T> | RequestRule>
}

type Logger = {
  info(args: any): void
  warn(args: any): void
  error(args: any): void
  debug(args: any): void
}

type ChaosConfig<T extends PromiseFunction> = {
  enabled: boolean
  autoRefreshExperimentName?: boolean
  logger?: Logger
  experiments?: Record<string, Experiment<T>>
  process?: "sequential" | "parallel"
  mitm?: any
}

type SocketOpts = {
  protocol: string // 'http:',
  hostname: string // 'localhost',
  hash: string // '',
  search: string // ""
  pathname: string // "/"
  path: string | null // null
  href: string // "http://localhost:4321/"
  port: string // 4321
  host: string // "localhost"
  servername: string // "localhost"
  _agentKey: string // "localhost:4321:"
  encoding: string | null // null
}

const UNDEFINED = "__undefined__"

let _experimentName: string

const experimentName = (refresh: boolean): string => {
  if (!refresh && _experimentName) {
    return _experimentName
  }
  _experimentName = process.env.LTBC_EXPERIMENT_NAME ?? UNDEFINED
  // console.log("enabled experiment name", _experimentName)
  return _experimentName
}

const wait = (delayInMs: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, delayInMs)
  })
}

const filterGlobalRule = <T extends PromiseFunction>(
  r: Rule<T>
): r is RequestRule =>
  r.type === "http" && r.host === undefined && r.href === undefined

type HostCountRequestRule = RequestRule & {
  host: string
  count: number
}

type CountLambdaRule<T extends PromiseFunction> = LambdaRule<T> & {
  count: number
}

type RequestRules = Record<string, HostCountRequestRule>

const filterHostRequestRule = <T extends PromiseFunction>(
  r: Rule<T>
): r is Required<HostCountRequestRule> => {
  return r.type === "http" && (r.host !== undefined || r.href !== undefined)
}

const filterLambdaRule = <T extends PromiseFunction>(
  r: Rule<T>
): r is Required<CountLambdaRule<T>> => {
  return r.type === "lambda"
}

type PromiseFunction = (...args: any[]) => Promise<any>
type PromiseReturnType<T extends (...args: any) => Promise<any>> = T extends (
  ...args: any
) => Promise<infer R>
  ? R
  : any

type FunctionWrapperFactory<T extends PromiseFunction> = (
  fn: T
) => (...args: Parameters<T>) => Promise<PromiseReturnType<T>>

const chaos = <T extends PromiseFunction>(
  config: ChaosConfig<T> = {
    enabled: false,
    autoRefreshExperimentName: false,
  }
): FunctionWrapperFactory<T> => {
  if (
    config.enabled &&
    experimentName(config.autoRefreshExperimentName ?? false) !== UNDEFINED &&
    config.experiments
  ) {
    const experiment =
      config.experiments?.[
        experimentName(config.autoRefreshExperimentName ?? false)
      ]

    const lambdaRules = (experiment?.rules ?? [])
      .filter(filterLambdaRule)
      // todo: here we have to do validation if config is valid or not
      // and print text with information what is incorrect
      .map((rule) => {
        rule.count = 0
        // todo: write test that that subsequent requests are delaying requests
        return (args: Parameters<T>) => {
          rule.count++
          if (rule.every && rule.count % rule.every !== 0) {
            return Promise.resolve()
          }

          if (rule.result) {
            return Promise.resolve(rule.result(...args))
          } else if (rule.error) {
            return Promise.reject(rule.error(...args))
          } else {
            return wait(rule.delay)
          }
        }
      })
    // we can only have single all connection rule
    // can only evaluated at the end
    const globalConnectionRule = (experiment?.rules ?? []).filter(
      filterGlobalRule
    )?.[0]

    // console.log("what are the experiments", experiment?.rules)
    const hostRules =
      (experiment?.rules ?? [])
        .filter(filterHostRequestRule)
        .reduce((acc, rule) => {
          const host = rule.host ?? rule.href
          return { ...acc, [host]: { ...rule, count: 0 } }
        }, {} as RequestRules) ?? {}
    // console.log("host rules", hostRules)
    if (Object.keys(hostRules).length > 0 || globalConnectionRule) {
      let mitm
      if (config.mitm) {
        mitm = config.mitm
      } else {
        const Mitm = require("@cabiri-io/mitm")
        mitm = new Mitm()
      }
      mitm.enable()
      mitm.on("connect", function (socket: any, _opts: SocketOpts) {
        // console.log("what are the opts", _opts)
        // todo: here we can use combination of keys
        // resolve them in order host / host + path /
        const hostRule = hostRules[_opts["host"]] ?? hostRules[_opts["href"]]
        // console.log("resolve rule", hostRule, _opts["host"], _opts["href"])
        if (hostRule !== undefined) {
          hostRule.count++
          if (
            hostRule.every !== undefined &&
            hostRule.count % hostRule.every !== 0
          ) {
            socket.bypass()
          } else if (hostRule.delay && hostRule.delay?.value) {
            socket.delay = hostRule.delay?.value
          } else if (hostRule.fail) {
            // allow to go to request
          } else {
            // this is error condition or maybe just bypass
            socket.bypass()
          }
          // you could have also a fail and delay which should go here
          // console.log("global connection rule", globalConnectionRule)
          // you can combine both host and global rune
          // global should allow fail as well
        } else if (
          globalConnectionRule &&
          globalConnectionRule.delay &&
          globalConnectionRule.delay.value
        ) {
          socket.delay = globalConnectionRule.delay?.value
        } else {
          // console.log("going to bypass")
          socket.bypass()
        }
      })

      mitm.on("request", function (req: any, res: any) {
        //   const key: string = req.headers.host
        //   const counter = hostInvocation[key]
        //   // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        //   console.log(`${req.headers.host} ${req.url}, invocation ${counter} returning 503`)
        // console.log("getting to result", _req)
        // ideally we would have failed here as well
        // setTimeout(() => {
        // }, 3000)
        // at the moment failed is only supported with host until we have full tests
        // hmm... this uses localhost:4321
        const host = (req.headers.host ?? "").split(":")[0]
        const hostRule = hostRules[host]
        if (hostRule.fail?.reason) {
          const { value } = hostRule.fail?.reason
          // console.log("what is the host", _req.headers.host)
          res.statusCode = value
          res.end(`${value} Service Error`)
        } else {
          // error log
          res.statusCode = 503
          res.end("host rule not defined in the LTBC correctly")
        }
      })
    }

    return (fn) => {
      // lambdaInvocation++
      // console.log("what is lambda rule", lambdaRules)
      return async (...args) => {
        const [...result] = await Promise.all(lambdaRules.map((r) => r(args)))
        // console.log("what is result", result)
        const toReturn = result.find((r) => r !== undefined)
        if (toReturn) {
          return toReturn
        }
        return fn(...args)
      }
    }
  }
  return (fn) => {
    return fn
  }
}

export { chaos }
export type { ChaosConfig }
