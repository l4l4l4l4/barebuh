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

#include <memory>

#include <QDateTime>
#include <QList>
#include <QMap>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSignalSpy>

#include "constants/barebuhsettings.h"
#include "core/networkaccessmanager.h"
#include "core/settings.h"
#include "core/taskmanager.h"
#include "radios/barebuhservice.h"
#include "radios/radioitem.h"
#include "radios/radiomodel.h"

using namespace Qt::Literals::StringLiterals;
using std::make_shared;

namespace {

const QByteArray kSearchPage =
    "{\"items\":[{\"station_id\":\"oradio:station:ed25519:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789\","
    "\"winning_record_id\":\"sha256:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789\","
    "\"tips\":[\"sha256:abcdefghijklmnopqrstuvwxyzABCDEFGH123456789\"],\"forked\":false,"
    "\"station\":{\"name\":\"Example FM\",\"country\":\"US\",\"tags\":[\"jazz\"],"
    "\"streams\":[{\"url\":\"https://stream.example/live\",\"transport\":\"https\",\"codec\":\"mp3\"}]},"
    "\"provenance\":[],\"indexed_at\":\"2026-09-26T12:00:00Z\",\"last_replication_at\":\"2026-09-26T12:00:00Z\","
    "\"policy_state\":\"admitted\",\"health\":{\"state\":\"unknown\",\"expires_at\":null}}],"
    "\"next_cursor\":null,\"has_more\":false,\"query_snapshot\":\"snapshot-1\"}";

QByteArray Discovery(const QByteArray &api_base) {
  return "{\"protocol\":\"oradio/1\",\"api_versions\":[1],\"api_base\":\"" + api_base + "\"}";
}

class ScriptedReply : public QNetworkReply {
 public:
  ScriptedReply(const QNetworkRequest &request, const int status, const QByteArray &data,
                const QMap<QByteArray, QByteArray> &headers, const NetworkError error, QObject *parent)
      : QNetworkReply(parent), data_(data), offset_(0) {
    setRequest(request);
    setUrl(request.url());
    setAttribute(QNetworkRequest::HttpStatusCodeAttribute, status);
    for (auto it = headers.cbegin(); it != headers.cend(); ++it) setRawHeader(it.key(), it.value());
    if (error != NoError) setError(error, u"scripted network failure"_s);
    open(QIODevice::ReadOnly);
  }

  void abort() override {}
  qint64 bytesAvailable() const override { return data_.size() - offset_ + QNetworkReply::bytesAvailable(); }
  void Complete() { Q_EMIT finished(); }

 protected:
  qint64 readData(char *data, const qint64 maximum) override {
    if (offset_ >= data_.size()) return -1;
    const qint64 count = qMin(maximum, data_.size() - offset_);
    memcpy(data, data_.constData() + offset_, static_cast<size_t>(count));
    offset_ += count;
    return count;
  }

 private:
  const QByteArray data_;
  qint64 offset_;
};

class ScriptedNetworkAccessManager : public NetworkAccessManager {
 public:
  struct Response {
    int status;
    QByteArray data;
    QMap<QByteArray, QByteArray> headers;
    QNetworkReply::NetworkError error = QNetworkReply::NoError;
  };

  void Enqueue(const int status, const QByteArray &data = {}, const QMap<QByteArray, QByteArray> &headers = {},
               const QNetworkReply::NetworkError error = QNetworkReply::NoError) {
    responses_ << Response{status, data, headers, error};
  }

  void Complete(const int index) { replies_.at(index)->Complete(); }
  const QList<QNetworkRequest> &requests() const { return requests_; }

 protected:
  QNetworkReply *createRequest(const Operation operation, const QNetworkRequest &request, QIODevice*) override {
    EXPECT_EQ(GetOperation, operation);
    EXPECT_LT(requests_.size(), responses_.size());
    const Response response = responses_.at(requests_.size());
    requests_ << request;
    ScriptedReply *reply = new ScriptedReply(request, response.status, response.data, response.headers, response.error, this);
    replies_ << reply;
    return reply;
  }

 private:
  QList<Response> responses_;
  QList<QNetworkRequest> requests_;
  QList<ScriptedReply*> replies_;
};

class BarebuhServiceTest : public ::testing::Test {
 protected:
  void SetUp() override {
    Settings settings;
    settings.beginGroup(QLatin1String(BarebuhSettings::kSettingsGroup));
    settings.remove(QString());
    settings.setValue(QLatin1String(BarebuhSettings::kEnabled), true);
    settings.setValue(QLatin1String(BarebuhSettings::kEndpoint), u"https://discovery.example"_s);
    settings.endGroup();
  }

  void TearDown() override {
    Settings settings;
    settings.beginGroup(QLatin1String(BarebuhSettings::kSettingsGroup));
    settings.remove(QString());
    settings.endGroup();
  }

  SharedPtr<TaskManager> tasks_ = make_shared<TaskManager>();
};

TEST_F(BarebuhServiceTest, PersistsValidatorAgainstActualSearchUrlAndUsesItFor304) {
  const auto network = make_shared<ScriptedNetworkAccessManager>();
  network->Enqueue(200, Discovery("https://api-a.example/v1/"));
  network->Enqueue(200, kSearchPage, {{"ETag", "\"search-a\""}});
  network->Enqueue(200, Discovery("https://api-a.example/v1/"));
  network->Enqueue(304);
  BarebuhService service(tasks_, network);
  QSignalSpy channels(&service, &RadioService::NewChannels);
  QSignalSpy state(&service, &RadioService::RefreshStateChanged);

  service.GetChannels();
  network->Complete(0);
  network->Complete(1);
  ASSERT_EQ(1, channels.count());
  ASSERT_EQ(1, state.count());
  EXPECT_TRUE(state.at(0).at(0).toBool());

  Settings settings;
  settings.beginGroup(QLatin1String(BarebuhSettings::kSettingsGroup));
  EXPECT_EQ(QUrl(u"https://api-a.example/v1/search?limit=64"_s), settings.value(QLatin1String(BarebuhSettings::kSearchEtagEndpoint)).toUrl());
  settings.endGroup();

  service.GetChannels();
  network->Complete(2);
  ASSERT_EQ(4, network->requests().size());
  EXPECT_EQ("\"search-a\"", network->requests().at(3).rawHeader("If-None-Match"));
  network->Complete(3);
  EXPECT_EQ(1, channels.count());
  ASSERT_EQ(2, state.count());
  EXPECT_TRUE(state.at(1).at(0).toBool());
}

TEST_F(BarebuhServiceTest, ApiBaseChangeClearsValidatorAndRejectsUnconditional304) {
  const auto network = make_shared<ScriptedNetworkAccessManager>();
  network->Enqueue(200, Discovery("https://api-a.example/v1/"));
  network->Enqueue(200, kSearchPage, {{"ETag", "\"search-a\""}});
  network->Enqueue(200, Discovery("https://api-b.example/v1/"));
  network->Enqueue(304);
  BarebuhService service(tasks_, network);
  QSignalSpy channels(&service, &RadioService::NewChannels);
  QSignalSpy state(&service, &RadioService::RefreshStateChanged);

  service.GetChannels();
  network->Complete(0);
  network->Complete(1);
  service.GetChannels();
  network->Complete(2);
  ASSERT_EQ(4, network->requests().size());
  EXPECT_TRUE(network->requests().at(3).rawHeader("If-None-Match").isEmpty());
  network->Complete(3);

  EXPECT_EQ(1, channels.count());
  ASSERT_EQ(2, state.count());
  EXPECT_FALSE(state.at(1).at(0).toBool());
  Settings settings;
  settings.beginGroup(QLatin1String(BarebuhSettings::kSettingsGroup));
  EXPECT_FALSE(settings.contains(QLatin1String(BarebuhSettings::kSearchEtag)));
  EXPECT_FALSE(settings.contains(QLatin1String(BarebuhSettings::kSearchEtagEndpoint)));
  settings.endGroup();
}

TEST_F(BarebuhServiceTest, FailedRefreshDoesNotReplaceLastKnownGoodAndMarksRowsStale) {
  const auto network = make_shared<ScriptedNetworkAccessManager>();
  network->Enqueue(200, Discovery("https://api.example/v1/"));
  network->Enqueue(200, kSearchPage);
  network->Enqueue(200, Discovery("https://api.example/v1/"));
  network->Enqueue(500, {}, {}, QNetworkReply::ConnectionRefusedError);
  BarebuhService service(tasks_, network);
  QSignalSpy channels(&service, &RadioService::NewChannels);
  QSignalSpy state(&service, &RadioService::RefreshStateChanged);

  service.GetChannels();
  network->Complete(0);
  network->Complete(1);
  service.GetChannels();
  network->Complete(2);
  network->Complete(3);

  EXPECT_EQ(1, channels.count());
  ASSERT_EQ(2, state.count());
  EXPECT_TRUE(state.at(0).at(0).toBool());
  EXPECT_FALSE(state.at(1).at(0).toBool());
}

TEST(BarebuhUiTest, OfflineTooltipShowsAccurateDataAge) {
  RadioModel model(nullptr, nullptr);
  RadioChannel channel;
  channel.source = Song::Source::Barebuh;
  channel.name = u"Cached FM"_s;
  channel.url = QUrl(u"https://stream.example/live"_s);
  channel.station_id = u"station"_s;
  channel.policy_state = u"admitted"_s;
  channel.health = u"unknown"_s;
  channel.refreshed_at = QDateTime::currentSecsSinceEpoch() - 300;
  model.AddChannels({channel});

  const QModelIndex service = model.index(0, 0);
  const QModelIndex station = model.index(0, 0, service);
  ASSERT_TRUE(station.isValid());
  EXPECT_TRUE(model.data(station, Qt::ToolTipRole).toString().contains(u"Data state: online"_s));
  model.SetSourceOffline(Song::Source::Barebuh, true);
  const QString tooltip = model.data(station, Qt::ToolTipRole).toString();
  EXPECT_TRUE(tooltip.contains(u"offline cache (stale until revalidated)"_s));
  EXPECT_TRUE(tooltip.contains(u"Data age: 300 seconds"_s) || tooltip.contains(u"Data age: 301 seconds"_s));
}

}  // namespace
