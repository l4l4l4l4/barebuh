/*
 * Strawberry Music Player
 * Copyright 2026, Barebuh contributors
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#include "gtest_include.h"

#include <QByteArray>

#include "core/song.h"
#include "radios/barebuhsearchparser.h"
#include "test_utils.h"

using namespace Qt::Literals::StringLiterals;

namespace {

QByteArray SearchPage(const QByteArray &items, const QByteArray &has_more = "false") {
  return "{\"items\":" + items + ",\"next_cursor\":null,\"has_more\":" + has_more + ",\"query_snapshot\":\"snapshot-1\"}";
}

QByteArray Station(const QByteArray &name = "Example FM", const QByteArray &url = "https://stream.example/live") {
  return "{\"station_id\":\"oradio:station:ed25519:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789\","
         "\"winning_record_id\":\"sha256:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789\","
         "\"tips\":[\"sha256:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789\"],\"forked\":false,"
         "\"station\":{\"name\":\"" + name + "\",\"country\":\"US\",\"tags\":[\"jazz\",\"live\"],"
         "\"streams\":[{\"url\":\"" + url + "\",\"transport\":\"https\",\"codec\":\"mp3\"}]},"
         "\"provenance\":[],\"indexed_at\":\"2026-09-26T12:00:00Z\",\"last_replication_at\":\"2026-09-26T12:00:00Z\","
         "\"policy_state\":\"admitted\",\"health\":{\"state\":\"unknown\",\"expires_at\":null}}";
}

}  // namespace

TEST(BarebuhSearchParserTest, ParsesValidPage) {
  const BarebuhSearchResult result = BarebuhSearchParser::Parse(SearchPage("[" + Station() + "]"));

  ASSERT_TRUE(result.valid) << result.error;
  ASSERT_EQ(1, result.channels.size());
  EXPECT_EQ(Song::Source::Barebuh, result.channels.first().source);
  EXPECT_EQ(u"Example FM"_s, result.channels.first().name);
  EXPECT_EQ(QUrl(u"https://stream.example/live"_s), result.channels.first().url);
  EXPECT_EQ(u"US"_s, result.channels.first().country);
  EXPECT_EQ(u"jazz, live"_s, result.channels.first().tags);
  EXPECT_EQ(u"mp3"_s, result.channels.first().codec);
}

TEST(BarebuhSearchParserTest, AcceptsValidEmptyPage) {
  const BarebuhSearchResult result = BarebuhSearchParser::Parse(SearchPage("[]"));
  EXPECT_TRUE(result.valid) << result.error;
  EXPECT_TRUE(result.channels.isEmpty());
}

TEST(BarebuhSearchParserTest, RejectsIncompletePagination) {
  const BarebuhSearchResult result = BarebuhSearchParser::Parse(SearchPage("[" + Station() + "]", "true"));
  EXPECT_FALSE(result.valid);
}

TEST(BarebuhSearchParserTest, RejectsUnsafeOrMalformedStreams) {
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + Station("Example", "file:///etc/passwd") + "]")).valid);
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + Station("Example", "https://user@example.test/live") + "]")).valid);
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + Station("Example", "https://example.test/live#fragment") + "]")).valid);
}

TEST(BarebuhSearchParserTest, RejectsInvalidProtocolIdentifiers) {
  QByteArray invalid_station_id = Station();
  invalid_station_id.replace("oradio:station:ed25519:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789", "oradio:station:ed25519:short");
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + invalid_station_id + "]")).valid);

  QByteArray invalid_record_id = Station();
  invalid_record_id.replace("sha256:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789", "sha256:not-a-digest");
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + invalid_record_id + "]")).valid);
}

TEST(BarebuhSearchParserTest, RejectsTransportUrlMismatch) {
  QByteArray station = Station();
  station.replace("\"transport\":\"https\"", "\"transport\":\"http\"");
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + station + "]")).valid);
}

TEST(BarebuhSearchParserTest, RejectsMalformedAndOversizedResponses) {
  EXPECT_FALSE(BarebuhSearchParser::Parse("not json").valid);
  EXPECT_FALSE(BarebuhSearchParser::Parse(QByteArray(BarebuhSearchParser::kMaximumResponseBytes + 1, 'x')).valid);
}

TEST(BarebuhSearchParserTest, RejectsDuplicateMembersAndInvalidUtf8) {
  EXPECT_FALSE(BarebuhSearchParser::Parse("{\"items\":[],\"items\":[],\"next_cursor\":null,\"has_more\":false,\"query_snapshot\":\"snapshot-1\"}").valid);
  QByteArray invalid_utf8 = SearchPage("[]");
  invalid_utf8.insert(invalid_utf8.indexOf("snapshot-1"), '\xff');
  EXPECT_FALSE(BarebuhSearchParser::Parse(invalid_utf8).valid);
}

TEST(BarebuhSearchParserTest, DeduplicatesByPlaybackUrl) {
  const QByteArray station = Station();
  const BarebuhSearchResult result = BarebuhSearchParser::Parse(SearchPage("[" + station + "," + station + "]"));
  ASSERT_TRUE(result.valid) << result.error;
  EXPECT_EQ(1, result.channels.size());
}

TEST(BarebuhSearchParserTest, RejectsPublishedBoundedIJsonViolations) {
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[]").replace("snapshot-1", "\\ud800")).valid);

  QByteArray deep = "0";
  for (int i = 0; i < 17; ++i) deep = "[" + deep + "]";
  EXPECT_FALSE(BarebuhSearchParser::IsValidIJson(deep, BarebuhSearchParser::kMaximumResponseBytes));

  EXPECT_FALSE(BarebuhSearchParser::IsValidIJson("{\"n\":9007199254740992}", BarebuhSearchParser::kMaximumResponseBytes));
  EXPECT_FALSE(BarebuhSearchParser::IsValidIJson("{\"n\":-1}", BarebuhSearchParser::kMaximumResponseBytes));
  EXPECT_FALSE(BarebuhSearchParser::IsValidIJson("{\"s\":\"" + QByteArray(4097, 'x') + "\"}", BarebuhSearchParser::kMaximumResponseBytes));

  QByteArray members = "{";
  for (int i = 0; i < 65; ++i) members += (i == 0 ? "" : ",") + QByteArray("\"") + QByteArray::number(i) + "\":null";
  members += "}";
  EXPECT_FALSE(BarebuhSearchParser::IsValidIJson(members, BarebuhSearchParser::kMaximumResponseBytes));
}

TEST(BarebuhSearchParserTest, RejectsIncompleteOrInvalidProjectionState) {
  QByteArray missing = Station();
  missing.replace("\"indexed_at\":\"2026-09-26T12:00:00Z\",", "");
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + missing + "]")).valid);

  QByteArray invalid_policy = Station();
  invalid_policy.replace("\"policy_state\":\"admitted\"", "\"policy_state\":\"attacker-defined\"");
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + invalid_policy + "]")).valid);

  QByteArray invalid_health = Station();
  invalid_health.replace("\"state\":\"unknown\",\"expires_at\":null", "\"state\":\"excellent\",\"expires_at\":\"not-a-time\"");
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + invalid_health + "]")).valid);

  QByteArray oversized_codec = Station();
  const QByteArray codec = QByteArray("\"codec\":\"") + QByteArray(1000, 'x') + QByteArray("\"");
  oversized_codec.replace("\"codec\":\"mp3\"", codec);
  EXPECT_FALSE(BarebuhSearchParser::Parse(SearchPage("[" + oversized_codec + "]")).valid);
}
