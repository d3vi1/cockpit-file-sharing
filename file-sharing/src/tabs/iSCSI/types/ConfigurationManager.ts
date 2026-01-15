import { useUserSettings } from "@/common/user-settings";
import {
  BashCommand,
  ProcessError,
  type Server,
  File,
  type CommandOptions,
} from "@45drives/houston-common-lib";
import { ResultAsync } from "neverthrow";

const userSettingsResult = ResultAsync.fromSafePromise(useUserSettings(true));

export class ConfigurationManager {
    server: Server;
    private commandOptionsWrite: CommandOptions = { superuser: "try" };
    
    constructor(server: Server) {
        this.server = server;
    }

    exportConfiguration(): ResultAsync<string, ProcessError> {
        return userSettingsResult.andThen((userSettings) => {
          return this.server
            .execute(
              new BashCommand(
                `scstadmin -write_config ${userSettings.value.iscsi.confPath}`,
                [],
                this.commandOptionsWrite
              )
            )
            .andThen(() =>
              this.server
                .execute(
                  new BashCommand(
                    `cat ${userSettings.value.iscsi.confPath}`,
                    [],
                    this.commandOptionsWrite
                  )
                )
                .map((proc) => proc.getStdout())
            );
        });
    }

    importConfiguration(newConfig: string) {
        return userSettingsResult.andThen((userSettings) => {
            return new File(this.server, userSettings.value.iscsi.confPath)
                .create(true, this.commandOptionsWrite)
                .andThen((file) => file.write(newConfig, this.commandOptionsWrite))
                .andThen(() =>
                  this.server.execute(
                    new BashCommand(
                      `scstadmin -check_config ${userSettings.value.iscsi.confPath}`,
                      [],
                      this.commandOptionsWrite
                    )
                  )
                )
                .map(() =>
                  this.server.execute(
                    new BashCommand(
                      `scstadmin -config ${userSettings.value.iscsi.confPath} -force -noprompt`,
                      [],
                      this.commandOptionsWrite
                    )
                  )
                )
                .mapErr(() => new ProcessError("Config file syntax validation failed."))
        });
    }

    saveCurrentConfiguration(): ResultAsync<File, ProcessError> {
        return userSettingsResult.andThen((userSettings) => {
            return new File(this.server, userSettings.value.iscsi.confPath)
                .create(true, this.commandOptionsWrite)
                .andThen((file) =>
                    this.exportConfiguration()
                        .map((config) => file.write(config, this.commandOptionsWrite))
                        .andThen(() =>
                          this.server.execute(
                            new BashCommand(`systemctl enable scst`, [], this.commandOptionsWrite)
                          )
                        )
                        .andThen(() =>
                          this.server.execute(
                            new BashCommand(
                              `scstadmin -config ${userSettings.value.iscsi.confPath}`,
                              [],
                              this.commandOptionsWrite
                            )
                          )
                        )
                        .map(() => file)
                );
        });
    }
}
