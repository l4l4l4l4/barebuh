/*
 * Strawberry Music Player
 * Copyright 2026, Barebuh contributors
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QString>

#include "core/iconloader.h"
#include "core/networkaccessmanager.h"
#include "core/settings.h"
#include "core/taskmanager.h"
#include "constants/barebuhsettings.h"
#include "barebuhsearchparser.h"
#include "barebuhservice.h"

using namespace Qt::Literals::StringLiterals;

namespace {
constexpr qint64 kMaximumDiscoveryBytes = 64 * 1024;
constexpr int kTransferTimeout = 15000;

bool IsHttpsEndpoint(const QUrl &url) {
  return url.isValid() && !url.isRelative() && url.scheme() == u"https"_s && !url.host().isEmpty() && url.userInfo().isEmpty() && !url.hasFragment();
}
}

BarebuhService::BarebuhService(const SharedPtr<TaskManager> task_manager, const SharedPtr<NetworkAccessManager> network, QObject *parent)
    : RadioService(Song::Source::Barebuh, u"Barebuh"_s, IconLoader::Load(u"radio"_s), task_manager, network, parent),
      enabled_(false) {
  ReloadSettings();
}

BarebuhService::~BarebuhService() { Abort(); }

QUrl BarebuhService::Homepage() { return endpoint_; }
QUrl BarebuhService::Donate() { return QUrl(); }

void BarebuhService::ReloadSettings() {

  Settings settings;
  settings.beginGroup(QLatin1String(BarebuhSettings::kSettingsGroup));
  enabled_ = settings.value(QLatin1String(BarebuhSettings::kEnabled), BarebuhSettings::kEnabledDefault).toBool();
  endpoint_ = QUrl(settings.value(QLatin1String(BarebuhSettings::kEndpoint), QLatin1String(BarebuhSettings::kEndpointDefault)).toString(), QUrl::StrictMode);
  search_etag_ = settings.value(QLatin1String(BarebuhSettings::kSearchEtag)).toByteArray();
  search_etag_url_ = settings.value(QLatin1String(BarebuhSettings::kSearchEtagEndpoint)).toUrl();
  settings.endGroup();

  if (!IsHttpsEndpoint(endpoint_)) enabled_ = false;
}

void BarebuhService::RefreshFailed(const QString &error) {
  Error(error);
  Q_EMIT RefreshStateChanged(false);
}

void BarebuhService::ClearSearchValidator() {
  search_etag_.clear();
  search_etag_url_.clear();
  Settings settings;
  settings.beginGroup(QLatin1String(BarebuhSettings::kSettingsGroup));
  settings.remove(QLatin1String(BarebuhSettings::kSearchEtag));
  settings.remove(QLatin1String(BarebuhSettings::kSearchEtagEndpoint));
  settings.endGroup();
}

void BarebuhService::Abort() {
  while (!replies_.isEmpty()) {
    QNetworkReply *reply = replies_.takeFirst();
    QObject::disconnect(reply, nullptr, this, nullptr);
    if (reply->isRunning()) reply->abort();
    reply->deleteLater();
  }
}

QNetworkReply *BarebuhService::Get(const QUrl &url, const QByteArray &etag) {
  QNetworkRequest request(url);
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
  request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
  request.setAttribute(QNetworkRequest::CacheSaveControlAttribute, false);
  request.setAttribute(QNetworkRequest::MaximumDownloadBufferSizeAttribute, BarebuhSearchParser::kMaximumResponseBytes);
  request.setTransferTimeout(kTransferTimeout);
  request.setRawHeader("Accept", "application/vnd.openradio.registry+json;version=1, application/json;q=0.8");
  if (!etag.isEmpty()) request.setRawHeader("If-None-Match", etag);
  QNetworkReply *reply = network_->get(request);
  replies_ << reply;
  return reply;
}

void BarebuhService::GetChannels() {

  Abort();
  ReloadSettings();
  if (!enabled_) return;

  QUrl discovery_url(endpoint_);
  discovery_url.setPath(u"/.well-known/open-radio-registry"_s);
  discovery_url.setQuery(QString());
  const int task_id = task_manager_->StartTask(tr("Discovering Barebuh registry"));
  QNetworkReply *reply = Get(discovery_url);
  QObject::connect(reply, &QNetworkReply::finished, this, [this, reply, task_id]() { DiscoveryFinished(reply, task_id); });
}

void BarebuhService::DiscoveryFinished(QNetworkReply *reply, const int task_id) {

  replies_.removeAll(reply);
  reply->deleteLater();
  task_manager_->SetTaskFinished(task_id);

  if (reply->error() != QNetworkReply::NoError || !IsHttpsEndpoint(reply->url()) || reply->bytesAvailable() > kMaximumDiscoveryBytes) {
    RefreshFailed(tr("Barebuh registry discovery failed."));
    return;
  }

  const QByteArray data = reply->readAll();
  if (!BarebuhSearchParser::IsValidIJson(data, kMaximumDiscoveryBytes)) {
    RefreshFailed(tr("Barebuh registry discovery returned invalid I-JSON."));
    return;
  }

  const QJsonDocument document = QJsonDocument::fromJson(data);
  if (!document.isObject()) {
    RefreshFailed(tr("Barebuh registry discovery returned invalid JSON."));
    return;
  }
  const QJsonObject object = document.object();
  const QJsonArray versions = object.value(u"api_versions"_s).toArray();
  bool supports_v1 = false;
  for (const QJsonValue &version : versions) supports_v1 = supports_v1 || version.toInt(-1) == 1;
  QUrl api_base(object.value(u"api_base"_s).toString(), QUrl::StrictMode);
  if (object.value(u"protocol"_s).toString() != u"oradio/1"_s || !supports_v1 || !IsHttpsEndpoint(api_base)) {
    RefreshFailed(tr("Barebuh registry discovery is incompatible."));
    return;
  }

  if (!api_base.path().endsWith(u'/')) api_base.setPath(api_base.path() + u'/');
  const QUrl search_url = api_base.resolved(QUrl(u"search?limit=64"_s));
  if (!IsHttpsEndpoint(search_url)) {
    RefreshFailed(tr("Barebuh registry advertised an unsafe search endpoint."));
    return;
  }

  if (search_etag_url_ != search_url) ClearSearchValidator();
  const QByteArray request_etag = search_etag_;
  const int search_task_id = task_manager_->StartTask(tr("Loading Barebuh stations"));
  QNetworkReply *search_reply = Get(search_url, request_etag);
  QObject::connect(search_reply, &QNetworkReply::finished, this, [this, search_reply, search_task_id, search_url, request_etag]() {
    SearchFinished(search_reply, search_task_id, search_url, request_etag);
  });
}

void BarebuhService::SearchFinished(QNetworkReply *reply, const int task_id, const QUrl &search_url, const QByteArray &request_etag) {

  replies_.removeAll(reply);
  reply->deleteLater();
  task_manager_->SetTaskFinished(task_id);

  const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
  if (status == 304 && reply->error() == QNetworkReply::NoError && reply->url() == search_url && !request_etag.isEmpty()) {
    Q_EMIT RefreshStateChanged(true);
    return;
  }

  if (reply->error() != QNetworkReply::NoError || status != 200 || reply->url() != search_url) {
    RefreshFailed(tr("Barebuh station refresh failed."));
    return;
  }

  const BarebuhSearchResult result = BarebuhSearchParser::Parse(reply->readAll());
  if (!result.valid) {
    RefreshFailed(tr("Barebuh station refresh was rejected: %1").arg(result.error));
    return;
  }

  search_etag_ = reply->rawHeader("ETag");
  search_etag_url_ = search_url;
  Settings settings;
  settings.beginGroup(QLatin1String(BarebuhSettings::kSettingsGroup));
  settings.setValue(QLatin1String(BarebuhSettings::kSearchEtag), search_etag_);
  settings.setValue(QLatin1String(BarebuhSettings::kSearchEtagEndpoint), search_etag_url_);
  settings.endGroup();

  Q_EMIT RefreshStateChanged(true);
  Q_EMIT NewChannels(result.channels);
}
