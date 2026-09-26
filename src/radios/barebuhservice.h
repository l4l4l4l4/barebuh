/*
 * Strawberry Music Player
 * Copyright 2026, Barebuh contributors
 *
 * Strawberry is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#ifndef BAREBUHSERVICE_H
#define BAREBUHSERVICE_H

#include <QList>
#include <QUrl>

#include "radioservice.h"

class QNetworkReply;
class NetworkAccessManager;
class TaskManager;

class BarebuhService : public RadioService {
  Q_OBJECT

 public:
  explicit BarebuhService(const SharedPtr<TaskManager> task_manager, const SharedPtr<NetworkAccessManager> network, QObject *parent = nullptr);
  ~BarebuhService() override;

  QUrl Homepage() override;
  QUrl Donate() override;
  void ReloadSettings() override;

 public Q_SLOTS:
  void GetChannels() override;

 private:
  void Abort();
  void DiscoveryFinished(QNetworkReply *reply, int task_id);
  void SearchFinished(QNetworkReply *reply, int task_id);
  QNetworkReply *Get(const QUrl &url);

  QList<QNetworkReply*> replies_;
  QUrl endpoint_;
  bool enabled_;
};

#endif  // BAREBUHSERVICE_H
