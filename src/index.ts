// Modules
import { config as config_env } from "dotenv-safe";
config_env();
import got from "got";
import fastify, { FastifyRequest } from "fastify";
import pLimit from "p-limit";
import fastifyCors from "@fastify/cors";

const origin = "https://myx.yan.gg";

// Classes
import ImmigrationUser from "./ImmigrationUser.js";
import config from "./config.js";

import { MessageEmbed, WebhookClient } from "discord.js";

const webhookClient = new WebhookClient({
  id: config.credentials.discord.webhook.id,
  token: config.credentials.discord.webhook.token,
});

// Typings
import {
  DefaultAPIResponse,
  RobloxAPI_ApiArrayResponse,
  RobloxAPI_GroupUserItem,
  RobloxAPI_MultiGetUserByNameResponse,
} from "./types.js";
import { getBlacklistedGroupIDs, getBlacklistedUserIDs } from "./scraper.js";
import { loadCookies } from "./cookies.js";
import {
  getAggregateActorData,
  getAggregateData,
  getDecisionValues,
  getMTBD,
  getRankingLogs,
  startDB,
} from "./postgres.js";
import {
  getMembershipGroupStaff,
  getMembershipStaff,
  processAuditLogs,
} from "./AuditAccuracy.js";

const requestCounter = {
  valid: 0 + config.stats.previousQueries,
};

const sessionStart = new Date();
const group = config.groups[0];

// Variables

const server = fastify({ trustProxy: "127.0.0.1" });
const port: number = config.port;

const automated_limit = pLimit(1);
const manual_limit = pLimit(1);

server.register(fastifyCors, {
  origin: [/localhost/, /yan3321\.com$/, /yan\.gg$/, /127.0.0.1/],
});

const flattenObject = (obj: any, prefix = "") =>
  Object.keys(obj).reduce((acc: any, k) => {
    const pre = prefix.length ? prefix + "." : "";
    if (typeof obj[k] === "object")
      Object.assign(acc, flattenObject(obj[k], pre + k));
    else acc[pre + k] = obj[k];
    return acc;
  }, {});

function isEmpty(text: string) {
  return text == null || text.match(/^\s*$/) !== null;
}

async function getImmigrationUser(
  userParam: string,
  userId: number,
  userName?: string
) {
  if (Number.isNaN(userId)) {
    const response = await got<any>(
      `https://users.roblox.com/v1/usernames/users`,
      {
        throwHttpErrors: false,
        method: "POST",
        json: {
          usernames: [userParam],
          excludeBannedUsers: true,
        },
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        responseType: "json",
      }
    );
    if (response) {
      if (response.statusCode === 200) {
        const json: RobloxAPI_ApiArrayResponse = response.body;
        if (json.data) {
          if (json.data.length !== 0) {
            json.data.forEach(
              (element: RobloxAPI_MultiGetUserByNameResponse) => {
                if (element.requestedUsername === userParam) {
                  if (element.name && element.id) {
                    userName = element.name;
                    userId = element.id;
                  } else {
                    throw new Error("Unable to get name and ID of user!");
                  }
                }
              }
            );
          } else {
            throw new Error("No user found with that username!");
          }
        }
      } else {
        console.error(response);
      }
    }
  }
  return new ImmigrationUser(userId, userName);
}

async function logPayload(req: FastifyRequest, payload: any) {
  try {
    requestCounter.valid++;
    const requestEmbed = new MessageEmbed()
      .setFields([
        {
          name: "Request URL",
          value: req.url,
          inline: true,
        },
        {
          name: "Request IP",
          value: req.ips ? req.ips[req.ips.length - 1] : "unavailable",
          inline: true,
        },
      ])
      .setTitle("Request data")
      .setTimestamp();
    const userEmbed = new MessageEmbed()
      .setFields([
        {
          name: "User ID",
          value: payload.user.userId.toString(),
          inline: true,
        },
        {
          name: "User Name",
          value: payload.user.username,
          inline: true,
        },
      ])
      .setTitle("User data");
    const testEmbed = new MessageEmbed()
      .setFields(
        Object.keys(payload.tests).map((key) => {
          const test = payload.tests[key as keyof typeof payload.tests];
          return {
            name: key,
            value: test.status ? "Yes" : "No",
          };
        })
      )
      .setTitle("Test data");
    webhookClient.send({
      username: "MECS",
      embeds: [requestEmbed, userEmbed, testEmbed],
    });
  } catch {}
}

interface userParams {
  id: string;
}

interface userParams2 {
  blacklistOnly: string;
}

server.get("/blacklist/groups", async (req, res) => {
  try {
    res.send(await getBlacklistedGroupIDs(undefined, true));
  } catch (error) {
    if (error instanceof Error) {
      res.status(500);
      res.send({ error: error.message });
    } else {
      res.status(500);
      res.send({ error: "Unknown error occured" });
    }
  }
});

server.get("/blacklist/users", async (req, res) => {
  try {
    res.send(await getBlacklistedUserIDs(undefined, true));
  } catch (error) {
    if (error instanceof Error) {
      res.status(500);
      res.send({ error: error.message });
    } else {
      res.status(500);
      res.send({ error: "Unknown error occured" });
    }
  }
});

interface MembershipAction {
  officer?: number;
  officerName?: string;
  target: {
    name: string;
    id: number;
  };
  action: "Grant" | "Refusal";
  correct: boolean;
  timestamps: {
    action: Date;
    review?: Date;
  };
  data?: DefaultAPIResponse;
}

interface AuditDecisionData {
  dar: {
    percentage: number;
    data: {
      correct: number;
      total: number;
    };
  };
  atbd?: {
    data: number[];
    mtbd: {
      mean: number | null;
      mode: number | null;
      median: number | null;
    };
  };

  last5: MembershipAction[];
}

async function getRankingHistory(targetId: number) {
  const rows = await getRankingLogs(undefined, undefined, targetId);
  const logs: MembershipAction[] = [];
  for (const item of rows) {
    let valid = false;
    const pass = item.review_pass;
    if (
      pass !== null &&
      item.review_data !== null &&
      item.review_timestamp !== null
    ) {
      if (parseInt(item.new_role_id) === group.rolesets.citizen) {
        valid = pass;
      } else {
        valid = !pass;
      }
      logs.push({
        officer: parseInt(item.actor_id),
        officerName:
          membershipStaffCache.find(
            (cacheItem) => cacheItem.user?.userId === parseInt(item.actor_id)
          )?.user?.username || undefined,
        target: {
          id: parseInt(item.target_id),
          name: item.review_data.user.username,
        },
        action:
          parseInt(item.new_role_id) === group.rolesets.citizen
            ? "Grant"
            : "Refusal",
        correct: valid,
        timestamps: {
          action: item.action_timestamp,
          review: item.review_timestamp,
        },
        data: item.review_data,
      });
    }
  }
  return logs;
}

interface AggregateData {
  actors: number;
  dar: {
    total: number;
    correct: number;
  };
  mtbd: number | null;
  timeRange: {
    latest: Date;
    oldest: Date;
  };
}

const cacheUpdateInterval = 5 * 60 * 1000; // 5 minutes

let aggregateDataCache: AggregateData | null = null;

async function updateAggregateDataCache() {
  try {
    aggregateDataCache = await getAggregateData();
  } catch (error) {
    console.error("Failed to update aggregate data cache:");
    console.error(error);
  }
}

setInterval(updateAggregateDataCache, cacheUpdateInterval);

server.get("/audit/accuracy", async (req, res) => {
  try {
    if (aggregateDataCache === null) {
      aggregateDataCache = await getAggregateData();
    }
    res.send(aggregateDataCache);
  } catch (error) {
    if (error instanceof Error) {
      res.status(500);
      res.send({ error: error.message });
    } else {
      res.status(500);
      res.send({ error: "Unknown error occured" });
    }
  }
});

async function getDecisionDataForAllOfficers() {
  const actorData = await getAggregateActorData();

  return actorData.map((data) => {
    const darData = data.dar;
    const mtbdData = data.mtbd;
    const decisions = {
      dar: {
        percentage: 0,
        data: {
          correct: 0,
          total: 0,
        },
      },

      atbd: {
        data: [] as number[],
        mtbd: {
          mean: null as number | null,
          mode: null as number | null,
          median: null as number | null,
        },
      },

      last5: [] as MembershipAction[],
    } as AuditDecisionData;

    decisions.dar.data.correct = darData.correct;
    decisions.dar.data.total = darData.total;
    decisions.dar.percentage =
      (decisions.dar.data.correct / decisions.dar.data.total) * 100;

    if (typeof mtbdData !== "number") {
      decisions.atbd = undefined;
    } else {
      // decisions.atbd.mtbd.mean = mean(decisions.atbd.data);
      if (decisions.atbd) decisions.atbd.mtbd.mode = mtbdData;
      // decisions.atbd.mtbd.median = median(decisions.atbd.data);
    }
    return {
      id: data.actorId,
      decisions: decisions,
    };
  });
}

async function getDecisionDataForOfficer(id: number) {
  const [darData, mtbdData, rows2] = await Promise.all([
    getDecisionValues(id),
    getMTBD(id),
    getRankingLogs(5, id, undefined),
  ]);

  if (darData?.total === 0 || darData === null) {
    throw new Error("No records for this actor");
  }

  const decisions = {
    dar: {
      percentage: 0,
      data: {
        correct: 0,
        total: 0,
      },
    },

    atbd: {
      data: [] as number[],
      mtbd: {
        mean: null as number | null,
        mode: null as number | null,
        median: null as number | null,
      },
    },
    last5: [] as MembershipAction[],
  } as AuditDecisionData;

  rows2.forEach((item2) => {
    let valid = false;

    const pass = item2.review_pass;

    if (pass !== null && item2.review_data && item2.review_timestamp) {
      if (parseInt(item2.new_role_id) === group.rolesets.citizen) {
        valid = pass;
      } else {
        valid = !pass;
      }
      decisions.last5.push({
        target: {
          id: parseInt(item2.target_id),
          name: item2.review_data.user.username,
        },
        action:
          parseInt(item2.new_role_id) === group.rolesets.citizen
            ? "Grant"
            : "Refusal",
        correct: valid,
        timestamps: {
          action: item2.action_timestamp,
          review: item2.review_timestamp,
        },
      });
    }
  });

  decisions.dar.data.correct = darData.correct;
  decisions.dar.data.total = darData.total;
  decisions.dar.percentage =
    (decisions.dar.data.correct / decisions.dar.data.total) * 100;

  if (typeof mtbdData !== "number") {
    delete decisions.atbd;
  } else {
    // decisions.atbd.mtbd.mean = mean(decisions.atbd.data);
    if (decisions.atbd) decisions.atbd.mtbd.mode = mtbdData;
    // decisions.atbd.mtbd.median = median(decisions.atbd.data);
  }

  return decisions;
}

async function preloadDecisionData() {
  const decisions = await getDecisionDataForAllOfficers();
  return decisions;
}

let membershipStaffCache: RobloxAPI_GroupUserItem[] = [];

let officerDecisionDataCache: OfficerDecisionData[] | null = null;

interface OfficerDecisionData {
  officer: {
    id: number;
    name?: string;
  };
  decisions: AuditDecisionData;
}

async function getOfficerDecisionData() {
  const [officers, decisionData] = await Promise.all([
    getMembershipGroupStaff(),
    preloadDecisionData(),
  ]);
  membershipStaffCache = officers;
  const data: OfficerDecisionData[] = [];
  for (const item of officers) {
    const decisions = decisionData.find(
      (item2) => item2.id === item.user?.userId
    );
    const user = item.user;
    if (user?.userId && decisions) {
      const dataItem: OfficerDecisionData = {
        officer: {
          id: user.userId,
          name: user.username,
        },
        decisions: decisions.decisions,
      };
      data.push(dataItem);
    }
  }
  const filtered = data.filter((item) => typeof item.decisions !== "undefined");
  filtered.sort((a, z) =>
    z.decisions.dar.data.total > a.decisions.dar.data.total ? 1 : -1
  );
  return filtered;
}

async function updateOfficerDecisionDataCache() {
  try {
    officerDecisionDataCache = await getOfficerDecisionData();
  } catch (error) {
    console.error("Failed to update officer decision data cache:");
    console.error(error);
  }
}

setInterval(updateOfficerDecisionDataCache, cacheUpdateInterval);

server.get("/audit/staff", async (req, res) => {
  try {
    if (officerDecisionDataCache === null) {
      officerDecisionDataCache = await getOfficerDecisionData();
    }
    res.send(officerDecisionDataCache);
  } catch (error) {
    if (error instanceof Error) {
      res.status(500);
      res.send({ error: error.message });
    } else {
      res.status(500);
      res.send({ error: "Unknown error occured" });
    }
  }
});

server.get<{ Params: userParams }>("/audit/staff/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id) {
      const decisions = await getDecisionDataForOfficer(id);
      res.send(decisions);
    } else {
      throw new Error("Invalid ID");
    }
  } catch (error) {
    if (error instanceof Error) {
      res.status(500);
      res.send({ error: error.message });
    } else {
      res.status(500);
      res.send({ error: "Unknown error occured" });
    }
  }
});

server.get<{ Params: userParams; Querystring: userParams2 }>(
  "/user/:id",
  async (req, res) => {
    const userParam: string = req.params.id;
    const blacklistOnly = req.query.blacklistOnly === "true";
    let userId: number = Number(userParam);

    try {
      if (isEmpty(userParam)) {
        throw new Error("User parameter is not valid.");
      }
      const limit = (() => {
        if (req.headers.origin === origin) {
          console.log("Manual limit in use");
          return manual_limit;
        }
        return automated_limit;
      })();
      const user = await limit(() => {
        return getImmigrationUser(userParam, userId);
      });

      const [testResults, hccGamepassOwned, history] = await Promise.all([
        limit(async () => user.getTestStatus(blacklistOnly)),
        user.getHCC().catch(() => false),
        getRankingHistory(user.userId).catch(() => undefined),
      ]);

      if (testResults !== null && typeof testResults !== "undefined") {
        const payload = {
          user: {
            userId: user.userId,
            username: user.username,
            groupMembership: user.groupMembership,
            hccGamepassOwned: hccGamepassOwned,
            exempt: user.groupMembership?.role?.id
              ? user.isExempt(user.groupMembership?.role?.id)
              : false,
          },
          tests: testResults,
          group: group,
          history: history,
        };
        logPayload(req, payload);
        res.send(payload);
      } else {
        res.status(500);
      }
    } catch (error) {
      if (error instanceof Error) {
        res.status(500);
        console.error(error);
        res.send({ error: error.message });
      } else {
        res.status(500);
        res.send({ error: "Unknown error occured" });
      }
    }
  }
);

server.post<{ Params: userParams; Querystring: userParams2 }>(
  "/user/:id/automated-review",
  async (req, res) => {
    const userParam: string = req.params.id;
    let userId: number = Number(userParam);
    try {
      if (isEmpty(userParam)) {
        throw new Error("User parameter is not valid.");
      }
      const limit = (() => {
        if (req.headers.origin === origin) {
          console.log("Manual limit in use");
          return manual_limit;
        }
        return automated_limit;
      })();
      const user = await limit(() => {
        return getImmigrationUser(userParam, userId);
      });
      const results = await limit(() => {
        return user.automatedReview();
      });
      res.status(200);
      res.send(results);
    } catch (error) {
      let errorString = "Unknown error occured";
      if (error instanceof Error) {
        errorString = error.message;
      }
      res.status(500);
      res.send({ error: errorString });
    }
  }
);

server.get("/session", async (req, res) => {
  try {
    res.send({
      requestCounter: requestCounter,
      sessionStart: sessionStart,
    });
  } catch (error) {
    if (error instanceof Error) {
      res.status(500);
      res.send({ error: error.message });
    } else {
      res.status(500);
      res.send({ error: "Unknown error occured" });
    }
  }
});

async function bootstrap() {
  await Promise.all([loadCookies(), startDB()]);
  await Promise.all([
    updateAggregateDataCache(),
    updateOfficerDecisionDataCache(),
  ]);
  const address = await server.listen(port);
  console.log(`Server listening at ${address}`);
  if (config.flags.processAudit) {
    if (config.flags.onlyNewAudit) {
      console.log("Processing latest audit logs...");
      await processAuditLogs(undefined, true);
    } else {
      console.log("Processing all audit logs...");
      await Promise.all([
        processAuditLogs(undefined, false),
        processAuditLogs(undefined, true),
      ]);
    }
  }
}

await bootstrap();
