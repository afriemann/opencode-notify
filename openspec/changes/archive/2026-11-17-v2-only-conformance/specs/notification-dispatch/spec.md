# Spec Delta

## MODIFIED Requirements

### Requirement: Session Title Tracking
The system SHALL maintain a per-session human-readable title for use in notification text, taken from the most recently observed session title event or, when none is known, looked up once from the host, and SHALL discard a session's state when that session is deleted.

#### Scenario: Title is cached when a session is created or renamed
- **WHEN** a session-created or session-renamed event carries a non-empty title
- **THEN** that title is recorded for the session's ID and used in any subsequent notification for that session

#### Scenario: Falls back to a truncated session ID when no title is known
- **WHEN** a notification is composed for a session whose title has never been recorded and the host cannot supply one
- **THEN** the notification uses a fallback label derived from the first eight characters of the session ID

#### Scenario: Title is looked up when no title event was observed
- **WHEN** a notification is composed for a session whose title has never been recorded and the host can supply it
- **THEN** the notification uses the title supplied by the host, and later notifications for that session reuse it without another lookup

#### Scenario: A failed lookup is not retried for every event
- **WHEN** the title lookup for a session fails
- **THEN** the fallback label is used and no further lookup is made for that session

#### Scenario: Session deletion discards the session's state
- **WHEN** a session-deleted event is received for a session
- **THEN** that session's recorded title and its open permission and input-request notification handles are discarded

### Requirement: Todo Notifications Are Unsupported On Some Runtimes
The system SHALL NOT emit todo-completion notifications, and SHALL emit exactly one startup warning when the todo-notification setting is explicitly present in configuration, so the gap is discoverable rather than silent.

#### Scenario: No todo notifications fire on a runtime with no todo event source
- **WHEN** any event is received, regardless of configuration
- **THEN** no todo-completion notification is sent

#### Scenario: A startup warning is emitted only when todo notifications were explicitly configured
- **WHEN** the system starts and the todo-notification setting was explicitly present in configuration, from the config file or from plugin options
- **THEN** exactly one warning is logged at startup noting that todo notifications are unavailable

#### Scenario: No startup warning when todo notifications were never configured
- **WHEN** the system starts and the todo-notification setting was never explicitly configured
- **THEN** no warning about the missing feature is logged

## ADDED Requirements

### Requirement: Plugin Options Override The Config File
The system SHALL apply options supplied to the plugin by the host over the same options read from the config file, merging notification categories individually.

#### Scenario: Plugin option overrides the config file
- **WHEN** the config file and the plugin options both set the same top-level option
- **THEN** the plugin option's value is used

#### Scenario: Notification categories merge individually
- **WHEN** the config file configures one notification category and the plugin options configure a different category
- **THEN** both categories' settings are applied

### Requirement: Task Finished Notification Fires On Session Completion
The system SHALL send the task-finished notification when the host reports that a session's execution succeeded.

#### Scenario: Notifies when session execution succeeds
- **WHEN** the host reports that a session's execution succeeded
- **THEN** the task-finished notification is sent naming the session

### Requirement: Unloading The Plugin Releases Its Processes
The system SHALL stop every notification-action monitor process it started when the plugin is unloaded, and SHALL NOT start new ones afterwards.

#### Scenario: Unload stops running monitors
- **WHEN** the plugin is unloaded while a notification-action monitor process is running
- **THEN** that process is terminated

#### Scenario: A notification sent during unload starts no monitor
- **WHEN** a desktop notification finishes sending after the plugin was unloaded
- **THEN** no monitor process is started for it

## REMOVED Requirements

### Requirement: Todo Completion Notification
**Reason**: The V2 runtime provides no todo event source, so this notification could never fire; V1 is no longer supported.
**Migration**: None. `notifications.todoCompleted` is still accepted in configuration but ignored.
