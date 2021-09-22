/* eslint-disable @typescript-eslint/no-explicit-any */
import { get, createServer, Server } from "http"
import { chaos } from "./"

const performance = (): ((arg?: any) => number) => {
  const start = Date.now()
  return (fn?: any): number => {
    fn?.()
    return Date.now() - start
  }
}
const Mitm = require("@cabiri-io/mitm")
const mitm = new Mitm()

describe("ltbc", () => {
  let server1: Server
  let server2: Server
  beforeAll(() => {
    server1 = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("okay")
    })
    server1.listen(4321)

    server2 = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end("okay")
    })
    server2.listen(1234)
  })

  afterAll(() => {
    server1.close()
    server2.close()
  })

  beforeEach(() => {
    mitm.disable()
    // there could be 3 states
    // undefined - no listeners
    // function - single listener
    // object - array of listener
    if (typeof mitm._events.connect === "function") {
      mitm.removeListener("connect", mitm._events.connect)
    }
    if (typeof mitm._events.request === "function") {
      mitm.removeListener("request", mitm._events.request)
    }
  })

  describe("disable/enabled", () => {
    it("passes the args to original function when chaos is disabled", async () => {
      const myFunction = async (value: string): Promise<string> =>
        `result: ${value}`

      const functionWithChaos = chaos<typeof myFunction>({
        enabled: false,
      })(myFunction)

      const result = await functionWithChaos("hello")
      expect(result).toBe("result: hello")
    })

    it("passes the args to original function when chaos is enabled", async () => {
      const myFunction = async (value: string): Promise<string> =>
        `result: ${value}`

      const functionWithChaos = chaos<typeof myFunction>({
        enabled: true,
        mitm,
      })(myFunction)

      const result = await functionWithChaos("hello")

      expect(result).toBe("result: hello")
    })
  })

  describe("lambda rules", () => {
    it("creates chaos function with delay", async () => {
      process.env.LTBC_EXPERIMENT_NAME = "slowLambda"
      const lambda = async (): Promise<string> => "result"

      expect(performance()(lambda)).toBeLessThan(50)

      const chaosTiming = performance()
      const lambdaWithChaos = chaos<typeof lambda>({
        enabled: true,
        mitm,
        autoRefreshExperimentName: true, // todo: explain why is it important
        experiments: {
          slowLambda: {
            name: "Lambda",
            rules: [
              {
                type: "lambda",
                delay: 200,
              },
            ],
          },
        },
      })(lambda)

      await lambdaWithChaos()
      expect(chaosTiming()).toBeGreaterThanOrEqual(200)

      await lambdaWithChaos()
      expect(chaosTiming()).toBeGreaterThanOrEqual(200)
    })

    it("creates chaos function with every x delay", async () => {
      process.env.LTBC_EXPERIMENT_NAME = "slowLambda"
      const lambda = async (): Promise<string> => "result"

      expect(performance()(lambda)).toBeLessThan(50)

      const chaosTiming = performance()
      const lambdaWithChaos = chaos<typeof lambda>({
        enabled: true,
        mitm,
        experiments: {
          slowLambda: {
            name: "Lambda",
            rules: [
              {
                type: "lambda",
                delay: 200,
                every: 2,
              },
            ],
          },
        },
      })(lambda)

      await lambdaWithChaos()
      expect(chaosTiming()).toBeLessThan(100)

      await lambdaWithChaos()
      expect(chaosTiming()).toBeGreaterThanOrEqual(200)

      await lambdaWithChaos()
      expect(chaosTiming()).toBeLessThan(300)

      await lambdaWithChaos()
      expect(chaosTiming()).toBeGreaterThanOrEqual(400)
    })

    it("creates function with error", async () => {
      process.env.LTBC_EXPERIMENT_NAME = "slowLambda"
      const lambda = async (a: string): Promise<string> => `result ${a}`

      const lambdaWithChaos = chaos<typeof lambda>({
        enabled: true,
        mitm,
        experiments: {
          slowLambda: {
            name: "Lambda",
            rules: [
              {
                type: "lambda",
                error: (value) => new Error(`error with value ${value}`),
              },
            ],
          },
        },
      })(lambda)

      return expect(lambdaWithChaos("a")).rejects.toThrow("error with value a")
    })

    it("creates function with error with multiple arguments", async () => {
      process.env.LTBC_EXPERIMENT_NAME = "slowLambda"
      const lambda = async (a: string, b: string, c: string): Promise<string> =>
        `${a} + ${b} = ${c}`

      const lambdaWithChaos = chaos<typeof lambda>({
        enabled: true,
        mitm,
        experiments: {
          slowLambda: {
            name: "Lambda",
            rules: [
              {
                type: "lambda",
                error: (a, b, c) => new Error(`${a} + ${b} = ${c}`),
              },
            ],
          },
        },
      })(lambda)

      return expect(lambdaWithChaos("1", "1", "3")).rejects.toThrow("1 + 1 = 3")
    })

    it("creates error every x invocation", async () => {
      process.env.LTBC_EXPERIMENT_NAME = "slowLambda"
      const lambda = async (a: string, b: string, c: string): Promise<string> =>
        `${a} + ${b} = ${c}`

      const lambdaWithChaos = chaos<typeof lambda>({
        enabled: true,
        mitm,
        experiments: {
          slowLambda: {
            name: "Lambda",
            rules: [
              {
                type: "lambda",
                every: 2,
                error: (a, b, c) => new Error(`${a} + ${b} = ${c}`),
              },
            ],
          },
        },
      })(lambda)

      expect(await lambdaWithChaos("1", "1", "2")).toBe("1 + 1 = 2")

      let error: Error
      try {
        await lambdaWithChaos("1", "1", "2")
      } catch (e) {
        error = e as Error
      }

      //@ts-expect-error it is not
      expect(error).toBeInstanceOf(Error)
      //@ts-expect-error it is not
      expect(error.message).toBe("1 + 1 = 2")

      expect(await lambdaWithChaos("1", "1", "2")).toBe("1 + 1 = 2")
    })

    it("creates return result", async () => {
      process.env.LTBC_EXPERIMENT_NAME = "slowLambda"
      const lambda = async (a: string, b: string, c: string): Promise<string> =>
        `${a} + ${b} = ${c}`

      const lambdaWithChaos = chaos<typeof lambda>({
        enabled: true,
        mitm,
        experiments: {
          slowLambda: {
            name: "Lambda",
            rules: [
              {
                type: "lambda",
                // you can have only one with return value
                result: (a, b, c) => `hey ${a} + ${b} = ${c}`,
              },
            ],
          },
        },
      })(lambda)

      expect(await lambdaWithChaos("1", "1", "2")).toBe("hey 1 + 1 = 2")
    })

    it("creates return result every x", async () => {
      process.env.LTBC_EXPERIMENT_NAME = "slowLambda"
      const lambda = async (a: string, b: string, c: string): Promise<string> =>
        `${a} + ${b} = ${c}`

      const lambdaWithChaos = chaos<typeof lambda>({
        enabled: true,
        mitm,
        experiments: {
          slowLambda: {
            name: "Lambda",
            rules: [
              {
                type: "lambda",
                every: 2,
                // you can have only one with return value
                result: (a, b, c) => `hey ${a} + ${b} = ${c}`,
              },
            ],
          },
        },
      })(lambda)

      expect(await lambdaWithChaos("1", "1", "2")).toBe("1 + 1 = 2")
      expect(await lambdaWithChaos("1", "1", "2")).toBe("hey 1 + 1 = 2")
      expect(await lambdaWithChaos("1", "1", "2")).toBe("1 + 1 = 2")
      expect(await lambdaWithChaos("1", "1", "2")).toBe("hey 1 + 1 = 2")
    })
  })

  describe("request rules", () => {
    describe("all", () => {
      it("delays all requests", async () => {
        process.env.LTBC_EXPERIMENT_NAME = "slowRequests"

        const lambda = async (): Promise<void> => {
          return new Promise((resolve) => {
            get("http://localhost:4321/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })
        }

        const chaosTiming = performance()
        const lambdaWithChaos = chaos<typeof lambda>({
          enabled: true,
          mitm,
          autoRefreshExperimentName: true,
          experiments: {
            slowRequests: {
              name: "Lambda",
              rules: [
                {
                  type: "http",
                  delay: {
                    value: 200,
                  },
                },
              ],
            },
          },
        })(lambda)

        await lambdaWithChaos()
        expect(chaosTiming()).toBeGreaterThanOrEqual(200)
      })
    })

    describe("host", () => {
      it("delays all requests to a host", async () => {
        process.env.LTBC_EXPERIMENT_NAME = "slowRequestServer2"

        const clientRequest1 = (): Promise<void> =>
          new Promise((resolve) => {
            get("http://localhost:4321/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })

        const clientRequest2 = (): Promise<void> =>
          new Promise((resolve) => {
            get("http://localhost:1234/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })

        const lambda = async (server: string): Promise<void> => {
          if (server === "server1") {
            return clientRequest1()
          } else if (server === "server2") {
            return clientRequest2()
          } else {
            await clientRequest1()
            await clientRequest2()
          }
        }

        const withChaos = chaos<typeof lambda>({
          enabled: true,
          autoRefreshExperimentName: true,
          mitm,
          experiments: {
            slowRequestServer2: {
              name: "slowRequestServer2",
              rules: [
                {
                  type: "http",
                  host: "localhost",
                  delay: {
                    value: 200,
                  },
                },
              ],
            },
          },
        })
        const lambdaWithChaos = withChaos(lambda)

        const chaosTimingServer1 = performance()
        await lambdaWithChaos("server1")
        expect(chaosTimingServer1()).toBeGreaterThan(200)

        const chaosTimingServer2 = performance()
        await lambdaWithChaos("server2")
        expect(chaosTimingServer2()).toBeGreaterThan(200)
      })

      it("delays every x request to a host", async () => {
        process.env.LTBC_EXPERIMENT_NAME = "slowRequestServer2"

        const clientRequest1 = (): Promise<void> =>
          new Promise((resolve) => {
            get("http://localhost:4321/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })

        const clientRequest2 = (): Promise<void> =>
          new Promise((resolve) => {
            get("http://localhost:1234/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })

        const lambda = async (server: string): Promise<void> => {
          if (server === "server1") {
            return clientRequest1()
          } else if (server === "server2") {
            return clientRequest2()
          } else {
            await clientRequest1()
            await clientRequest2()
          }
        }

        const withChaos = chaos<typeof lambda>({
          enabled: true,
          autoRefreshExperimentName: true,
          mitm,
          experiments: {
            slowRequestServer2: {
              name: "slowRequestServer2",
              rules: [
                {
                  type: "http",
                  host: "localhost",
                  every: 2,
                  delay: {
                    value: 200,
                  },
                },
              ],
            },
          },
        })
        const lambdaWithChaos = withChaos(lambda)

        const chaosTimingServer1 = performance()
        await lambdaWithChaos("server1")
        expect(chaosTimingServer1()).toBeLessThan(200)

        const chaosTimingServer2 = performance()
        await lambdaWithChaos("server2")
        expect(chaosTimingServer2()).toBeGreaterThan(200)
      })

      it("failes all requests with status code", async () => {
        process.env.LTBC_EXPERIMENT_NAME = "slowRequestServer2"

        type Result = { body: string; statusCode: number | undefined }
        const clientRequest1 = (): Promise<Result> =>
          new Promise((resolve) => {
            get("http://localhost:4321/", (res) => {
              res.on("data", (data) => {
                resolve({ body: data.toString(), statusCode: res.statusCode })
              })
            })
          })

        const lambda = async (): Promise<Result> => {
          return clientRequest1()
        }

        const withChaos = chaos<typeof lambda>({
          enabled: true,
          autoRefreshExperimentName: true,
          mitm,
          experiments: {
            slowRequestServer2: {
              name: "slowRequestServer2",
              rules: [
                {
                  type: "http",
                  host: "localhost",
                  fail: {
                    reason: { type: "HTTP_RESPONSE_CODE", value: 503 },
                  },
                },
              ],
            },
          },
        })
        const lambdaWithChaos = withChaos(lambda)

        const result = await lambdaWithChaos()

        expect(result.statusCode).toBe(503)
        expect(result.body).toBe("503 Service Error")
      })

      it("failes every x request with status code", async () => {
        process.env.LTBC_EXPERIMENT_NAME = "slowRequestServer2"

        type Result = { body: string; statusCode: number | undefined }
        const clientRequest1 = (): Promise<Result> =>
          new Promise((resolve) => {
            get("http://localhost:4321/", (res) => {
              res.on("data", (data) => {
                resolve({ body: data.toString(), statusCode: res.statusCode })
              })
            })
          })

        const lambda = async (): Promise<Result> => {
          return clientRequest1()
        }

        const withChaos = chaos<typeof lambda>({
          enabled: true,
          autoRefreshExperimentName: true,
          mitm,
          experiments: {
            slowRequestServer2: {
              name: "slowRequestServer2",
              rules: [
                {
                  type: "http",
                  host: "localhost",
                  every: 2,
                  fail: {
                    reason: { type: "HTTP_RESPONSE_CODE", value: 503 },
                  },
                },
              ],
            },
          },
        })
        const lambdaWithChaos = withChaos(lambda)

        const firstResult = await lambdaWithChaos()

        expect(firstResult.statusCode).toBe(200)
        expect(firstResult.body).toBe("okay")

        const secondResult = await lambdaWithChaos()

        expect(secondResult.statusCode).toBe(503)
        expect(secondResult.body).toBe("503 Service Error")
      })
    })

    describe("href", () => {
      it("delays a requests to specific href", async () => {
        process.env.LTBC_EXPERIMENT_NAME = "slowRequestServer2"

        const clientRequest1 = (): Promise<void> =>
          new Promise((resolve) => {
            get("http://localhost:4321/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })

        const clientRequest2 = (): Promise<void> =>
          new Promise((resolve) => {
            get("http://localhost:1234/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })

        const lambda = async (server: string): Promise<void> => {
          if (server === "server1") {
            return clientRequest1()
          } else if (server === "server2") {
            return clientRequest2()
          } else {
            await clientRequest1()
            await clientRequest2()
          }
        }

        const withChaos = chaos<typeof lambda>({
          enabled: true,
          autoRefreshExperimentName: true,
          mitm,
          experiments: {
            slowRequestServer2: {
              name: "slowRequestServer2",
              rules: [
                {
                  type: "http",
                  href: "http://localhost:1234/",
                  delay: {
                    value: 200,
                  },
                },
              ],
            },
          },
        })
        const lambdaWithChaos = withChaos(lambda)

        const chaosTimingServer1 = performance()
        await lambdaWithChaos("server1")
        expect(chaosTimingServer1()).toBeLessThan(200)

        const chaosTimingServer2 = performance()
        await lambdaWithChaos("server2")
        expect(chaosTimingServer2()).toBeGreaterThan(200)
      })

      it("delays every x request to specific href", async () => {
        process.env.LTBC_EXPERIMENT_NAME = "every3rdRequestSlower"

        const clientRequest = (): Promise<void> =>
          new Promise((resolve) => {
            get("http://localhost:4321/", (res) => {
              res.on("data", () => {
                resolve()
              })
            })
          })

        const lambda = async (): Promise<void> => {
          return clientRequest()
        }

        const lambdaWithChaos = chaos({
          enabled: true,
          autoRefreshExperimentName: true,
          mitm,
          experiments: {
            every3rdRequestSlower: {
              name: "slowRequestServer2",
              rules: [
                {
                  type: "http",
                  href: "http://localhost:4321/",
                  every: 3,
                  delay: {
                    value: 200,
                  },
                },
              ],
            },
          },
        })(lambda)

        const chaosTimingFirstRequest = performance()
        await lambdaWithChaos()
        expect(chaosTimingFirstRequest()).toBeLessThan(200)

        const chaosTimingSecondRequest = performance()
        await lambdaWithChaos()
        expect(chaosTimingSecondRequest()).toBeLessThan(200)

        const chaosTimingThirdRequest = performance()
        await lambdaWithChaos()
        expect(chaosTimingThirdRequest()).toBeGreaterThan(200)

        const chaosTimingFourthRequest = performance()
        await lambdaWithChaos()
        expect(chaosTimingFourthRequest()).toBeLessThan(200)
      })
    })
  })
})
