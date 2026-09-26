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
         "\"policy_state\":\"admitted\",\"health\":{\"state\":\"unknown\"}}";
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
