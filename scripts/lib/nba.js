const fs = require("fs");
const path = require("path");

const teams = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "data", "nba-teams.json"), "utf8")
);

const teamsByEspnAbbreviation = new Map(
  teams.map((team) => [team.espnAbbreviation.toUpperCase(), team])
);

const teamsById = new Map(teams.map((team) => [team.id, team]));
const arenasById = new Map(teams.map((team) => [team.arena.id, team.arena]));

function getLocalDateParts(utcIsoString, timeZone) {
  const date = new Date(utcIsoString);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short"
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    gameDate: `${parts.year}-${parts.month}-${parts.day}`,
    localDateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    localHour: Number(parts.hour),
    dayOfWeek: weekdayMap[parts.weekday]
  };
}

function seasonDateRange(seasonStartYear) {
  const start = new Date(Date.UTC(Number(seasonStartYear), 9, 1));
  const end = new Date(Date.UTC(Number(seasonStartYear) + 1, 6, 1));
  return { start, end };
}

function getSeasonLabel(seasonStartYear) {
  const startYear = Number(seasonStartYear);
  const endYear = startYear + 1;
  return `${startYear}-${String(endYear).slice(-2)}`;
}

function dateKey(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function dateKeysBetween(start, end) {
  const keys = [];
  const current = new Date(start);
  while (current <= end) {
    keys.push(dateKey(current));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return keys;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const deltaLat = toRadians(lat2 - lat1);
  const deltaLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(deltaLon / 2) ** 2;

  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a));
}

function estimateFlightMinutes(distanceMiles) {
  if (distanceMiles === 0) return 0;
  const cruiseMph = 500;
  const fixedGroundMinutes = 45;
  return Math.round((distanceMiles / cruiseMph) * 60 + fixedGroundMinutes);
}

function timezoneOffsetHours(timeZone, date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset"
  });
  const parts = formatter.formatToParts(date);
  const timeZoneName = parts.find((part) => part.type === "timeZoneName")?.value || "GMT";
  const match = timeZoneName.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/i);
  if (!match) return 0;
  const hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) / 60 : 0;
  return hours >= 0 ? hours + minutes : hours - minutes;
}

module.exports = {
  teams,
  teamsByEspnAbbreviation,
  teamsById,
  arenasById,
  getLocalDateParts,
  seasonDateRange,
  getSeasonLabel,
  dateKeysBetween,
  haversineMiles,
  estimateFlightMinutes,
  timezoneOffsetHours
};
