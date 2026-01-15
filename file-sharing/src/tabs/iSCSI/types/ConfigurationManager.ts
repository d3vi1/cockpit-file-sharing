import { useUserSettings } from "@/common/user-settings";
import {
  Command,
  ProcessError,
  type Server,
  File,
  type CommandOptions,
  Path,
} from "@45drives/houston-common-lib";
import { errAsync, okAsync } from "neverthrow";
import { ResultAsync } from "neverthrow";

const userSettingsResult = ResultAsync.fromSafePromise(useUserSettings(true));

export class ConfigurationManager {
    server: Server;
    private commandOptionsWrite: CommandOptions = { superuser: "try" };

    private ensureAbsolutePath(path: string, label: string) {
      if (!new Path(path).isAbsolute()) {
        return errAsync(new ProcessError(`${label} must be an absolute path.`));
      }
      if (/[\r\n]/.test(path)) {
        return errAsync(new ProcessError(`${label} must be a single line.`));
      }
      return okAsync(path);
    }
    
    constructor(server: Server) {
        this.server = server;
    }

    exportConfiguration(): ResultAsync<string, ProcessError> {
        return userSettingsResult.andThen((userSettings) => {
          return this.ensureAbsolutePath(userSettings.value.iscsi.confPath, "iSCSI config path")
            .andThen((confPath) => {
          return this.server
            .execute(
              new Command(["scstadmin", "-write_config", confPath], this.commandOptionsWrite)
            )
            .andThen(() =>
              this.server
                .execute(new Command(["cat", confPath], this.commandOptionsWrite))
                .map((proc) => proc.getStdout())
            );
            });
        });
    }

    importConfiguration(newConfig: string) {
        return userSettingsResult.andThen((userSettings) => {
            return this.ensureAbsolutePath(userSettings.value.iscsi.confPath, "iSCSI config path")
              .andThen((confPath) => {
            return new File(this.server, confPath)
                .create(true, this.commandOptionsWrite)
                .andThen((file) => file.write(newConfig, this.commandOptionsWrite))
                .andThen(() =>
                  this.server.execute(
                    new Command(["scstadmin", "-check_config", confPath], this.commandOptionsWrite)
                  )
                )
                .map(() =>
                  this.server.execute(
                    new Command(
                      ["scstadmin", "-config", confPath, "-force", "-noprompt"],
                      this.commandOptionsWrite
                    )
                  )
                )
                .mapErr(() => new ProcessError("Config file syntax validation failed."))
              });
        });
    }

    saveCurrentConfiguration(): ResultAsync<File, ProcessError> {
        return userSettingsResult.andThen((userSettings) => {
            return this.ensureAbsolutePath(userSettings.value.iscsi.confPath, "iSCSI config path")
              .andThen((confPath) => {
            return new File(this.server, confPath)
                .create(true, this.commandOptionsWrite)
                .andThen((file) =>
                    this.exportConfiguration()
                        .map((config) => file.write(config, this.commandOptionsWrite))
                        .andThen(() =>
                          this.server.execute(
                            new Command(["systemctl", "enable", "scst"], this.commandOptionsWrite)
                          )
                        )
                        .andThen(() =>
                          this.server.execute(
                            new Command(["scstadmin", "-config", confPath], this.commandOptionsWrite)
                          )
                        )
                        .map(() => file)
                );
              });
        });
    }
}
