import { ConfigurationManager } from '@/tabs/iSCSI/types/ConfigurationManager';
import { Directory, File, type CommandOptions, Path } from "@45drives/houston-common-lib";
import { VirtualDevice, DeviceType } from "@/tabs/iSCSI/types/VirtualDevice";
import { CHAPConfiguration, CHAPType } from "@/tabs/iSCSI/types/CHAPConfiguration";
import { type Connection } from "@/tabs/iSCSI/types/Connection";
import { type Initiator } from "@/tabs/iSCSI/types/Initiator";
import { type InitiatorGroup } from "@/tabs/iSCSI/types/InitiatorGroup";
import { LogicalUnitNumber } from "@/tabs/iSCSI/types/LogicalUnitNumber";
import { Portal } from "@/tabs/iSCSI/types/Portal";
import { type Session } from "@/tabs/iSCSI/types/Session";
import { type Target } from "@/tabs/iSCSI/types/Target";
import { ISCSIDriver } from "@/tabs/iSCSI/types/drivers/ISCSIDriver";
import { Command, ParsingError, ProcessError, Server, StringToIntCaster } from "@45drives/houston-common-lib";
import { ResultAsync, err, errAsync, ok, okAsync, safeTry } from "neverthrow";

export class ISCSIDriverSingleServer implements ISCSIDriver {

    server: Server;
    configurationManager: ConfigurationManager;
    private commandOptionsWrite: CommandOptions = { superuser: "try" };

    deviceTypeToHandlerDirectory = {
        [DeviceType.BlockIO]: "/sys/kernel/scst_tgt/handlers/vdisk_blockio",
        [DeviceType.FileIO]: "/sys/kernel/scst_tgt/handlers/vdisk_fileio"
    };

    targetManagementDirectory = "/sys/kernel/scst_tgt/targets/iscsi";

    constructor(server: Server) {
        this.server = server;
        this.configurationManager = new ConfigurationManager(server);
    }

    private ensureNoWhitespace(value: string, label: string) {
        return /\s/.test(value)
            ? errAsync(new ProcessError(`${label} must not contain whitespace.`))
            : okAsync(value);
    }

    private ensureAbsolutePath(value: string, label: string) {
        return new Path(value).isAbsolute()
            ? okAsync(value)
            : errAsync(new ProcessError(`${label} must be an absolute path.`));
    }

    private ensurePositiveNumber(value: number, label: string) {
        return Number.isFinite(value) && value > 0
            ? okAsync(value)
            : errAsync(new ProcessError(`${label} must be a positive number.`));
    }

    private writeScstMgmt(path: string, content: string): ResultAsync<void, ProcessError> {
        return new File(this.server, path)
            .write(`${content}\n`, this.commandOptionsWrite)
            .map(() => undefined);
    }

    initialize(): ResultAsync<ISCSIDriver, ProcessError> {
        return new Directory(this.server, "/sys/kernel/scst_tgt").exists()
        .andThen((exists) => {
            return exists ? ok(this) : err(new ProcessError("/sys/kernel/scst_tgt was not found. Is SCST installed?"));
        })
    }

    getHandledDeviceTypes(): DeviceType[] {
        return Object.keys(this.deviceTypeToHandlerDirectory) as DeviceType[];
    }

    addVirtualDevice(virtualDevice: VirtualDevice): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(virtualDevice.deviceName, "Device name"),
            this.ensureAbsolutePath(virtualDevice.filePath, "Device path")
              .andThen((path) => this.ensureNoWhitespace(path, "Device path")),
            this.ensurePositiveNumber(virtualDevice.blockSize, "Block size"),
        ]).andThen(() =>
            this.writeScstMgmt(
                this.deviceTypeToHandlerDirectory[virtualDevice.deviceType] + "/mgmt",
                `add_device ${virtualDevice.deviceName} filename=${virtualDevice.filePath};blocksize=${virtualDevice.blockSize}`
            )
        )
        .andThen(() => this.configurationManager.saveCurrentConfiguration())
        .map(() => undefined);
    }

    removeVirtualDevice(virtualDevice: VirtualDevice): ResultAsync<void, ProcessError> {
        return this.ensureNoWhitespace(virtualDevice.deviceName, "Device name")
            .andThen(() =>
                this.writeScstMgmt(
                    this.deviceTypeToHandlerDirectory[virtualDevice.deviceType] + "/mgmt",
                    `del_device ${virtualDevice.deviceName}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    createTarget(target: Target): ResultAsync<void, ProcessError> {
        return this.ensureNoWhitespace(target.name, "Target name")
            .andThen(() =>
                this.writeScstMgmt(this.targetManagementDirectory + "/mgmt", `add_target ${target.name}`)
            )
            .andThen(() => this.writeScstMgmt(this.targetManagementDirectory + "/enabled", "1"))
            .andThen(() =>
                this.writeScstMgmt(`${this.targetManagementDirectory}/${target.name}/enabled`, "1")
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    removeTarget(target: Target): ResultAsync<void, ProcessError> {
        return this.ensureNoWhitespace(target.name, "Target name")
            .andThen(() =>
                this.writeScstMgmt(this.targetManagementDirectory + "/mgmt", `del_target ${target.name}`)
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    addPortalToTarget(target: Target, portal: Portal): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(target.name, "Target name"),
            this.ensureNoWhitespace(portal.address, "Portal address"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${this.getTargetPath(target)}/../mgmt`,
                    `add_target_attribute ${target.name} allowed_portal=${portal.address}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    deletePortalFromTarget(target: Target, portal: Portal): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(target.name, "Target name"),
            this.ensureNoWhitespace(portal.address, "Portal address"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${this.getTargetPath(target)}/../mgmt`,
                    `del_target_attribute ${target.name} allowed_portal=${portal.address}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    addInitiatorGroupToTarget(target: Target, initiatorGroup: InitiatorGroup): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(target.name, "Target name"),
            this.ensureNoWhitespace(initiatorGroup.name, "Initiator group name"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${this.getTargetPath(target)}/ini_groups/mgmt`,
                    `create ${initiatorGroup.name}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    deleteInitiatorGroupFromTarget(target: Target, initiatorGroup: InitiatorGroup): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(target.name, "Target name"),
            this.ensureNoWhitespace(initiatorGroup.name, "Initiator group name"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${this.getTargetPath(target)}/ini_groups/mgmt`,
                    `del ${initiatorGroup.name}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    addInitiatorToGroup(initiatorGroup: InitiatorGroup, initiator: Initiator): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(initiatorGroup.name, "Initiator group name"),
            this.ensureNoWhitespace(initiator.name, "Initiator name"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${initiatorGroup.devicePath}/initiators/mgmt`,
                    `add ${initiator.name}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    removeInitiatorFromGroup(initiatorGroup: InitiatorGroup, initiator: Initiator): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(initiatorGroup.name, "Initiator group name"),
            this.ensureNoWhitespace(initiator.name, "Initiator name"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${initiatorGroup.devicePath}/initiators/mgmt`,
                    `del ${initiator.name}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    addLogicalUnitNumberToGroup(initiatorGroup: InitiatorGroup, logicalUnitNumber: LogicalUnitNumber): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(initiatorGroup.name, "Initiator group name"),
            this.ensureNoWhitespace(logicalUnitNumber.name, "LUN name"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${initiatorGroup.devicePath}/luns/mgmt`,
                    `add ${logicalUnitNumber.name} ${logicalUnitNumber.unitNumber}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    removeLogicalUnitNumberFromGroup(initiatorGroup: InitiatorGroup, logicalUnitNumber: LogicalUnitNumber): ResultAsync<void, ProcessError> {
        return this.ensureNoWhitespace(initiatorGroup.name, "Initiator group name")
            .andThen(() =>
                this.writeScstMgmt(
                    `${initiatorGroup.devicePath}/luns/mgmt`,
                    `del ${logicalUnitNumber.unitNumber}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    addCHAPConfigurationToTarget(target: Target, chapConfiguration: CHAPConfiguration): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(target.name, "Target name"),
            this.ensureNoWhitespace(chapConfiguration.username, "CHAP username"),
            this.ensureNoWhitespace(chapConfiguration.password, "CHAP password"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${this.getTargetPath(target)}/../mgmt`,
                    `add_target_attribute ${target.name} ${chapConfiguration.chapType}=${chapConfiguration.username} ${chapConfiguration.password}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }

    removeCHAPConfigurationFromTarget(target: Target, chapConfiguration: CHAPConfiguration): ResultAsync<void, ProcessError> {
        return ResultAsync.combine([
            this.ensureNoWhitespace(target.name, "Target name"),
            this.ensureNoWhitespace(chapConfiguration.username, "CHAP username"),
        ])
            .andThen(() =>
                this.writeScstMgmt(
                    `${this.getTargetPath(target)}/../mgmt`,
                    `del_target_attribute ${target.name} ${chapConfiguration.chapType}=${chapConfiguration.username}`
                )
            )
            .andThen(() => this.configurationManager.saveCurrentConfiguration())
            .map(() => undefined);
    }
    private getUsedByIscsiDeviceNames(): ResultAsync<Set<string>, ProcessError> {
        return this.server
          .execute(
            new Command(["bash","-lc","cat /sys/kernel/scst_tgt/targets/iscsi/*/ini_groups/*/luns/*/device/prod_id 2>/dev/null || true",
            ])
          )
          .map((proc) => {
            const names = proc
              .getStdout()
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            return new Set(names);
          });
      }
      
      getVirtualDevices(): ResultAsync<VirtualDevice[], ProcessError> {
        const deviceTypesToCheck = [DeviceType.BlockIO, DeviceType.FileIO];
        const results = deviceTypesToCheck.map((t) => this.getVirtualDevicesOfDeviceType(t));
      
        return ResultAsync.combine(results)
          .map((devices) => devices.flat())
          .andThen((devices) =>
            this.getUsedByIscsiDeviceNames().map((usedSet) => {
              for (const d of devices) {
                d.assigned = usedSet.has(d.deviceName);
              }
              return devices;
            })
          );
      }
      

    getVirtualDevicesOfDeviceType(deviceType: DeviceType): ResultAsync<VirtualDevice[], ProcessError> { 
        return this.server.execute(new Command(["find", this.deviceTypeToHandlerDirectory[deviceType], ..."-mindepth 1 -maxdepth 1 ( -type d -o -type l ) -printf %f\\0".split(" ")])).map(
            (proc) => {
                const virtualDeviceNames = proc.getStdout().split("\0").slice(0, -1);
                return virtualDeviceNames;
            }
        ).andThen((virtualDeviceNames) => {
            return ResultAsync.combine(virtualDeviceNames.map((virtualDeviceName) => {
                const virtualDevicePath = this.deviceTypeToHandlerDirectory[deviceType] + "/" + virtualDeviceName;

                const blockSizeResult =  this.server.execute(new Command(["cat", virtualDevicePath + "/blocksize"])).andThen((proc) => {
                    const blockSizeString = proc.getStdout().trim();
                    const maybeBlockSize = StringToIntCaster()(blockSizeString);

                    if (maybeBlockSize.isNone())
                        return err(new ParsingError(`Failed to parse block size: ${blockSizeString}`))
    
                    return ok(maybeBlockSize.some());
                }); 
                
                const filePathResult =  this.server.execute(new Command(["cat", virtualDevicePath + "/filename"])).andThen((proc) => {
                    const filePathString = proc.getStdout().split('\n')[0];
    
                    if (filePathString === undefined)
                        return err(new ParsingError(`Failed to read file path: ${proc.getStdout()}`));

                    return ok(filePathString);
                });  
                return ResultAsync.combine([blockSizeResult, filePathResult]).map(([blockSize, filePath]) => {
                    return new VirtualDevice(virtualDeviceName, filePath, blockSize, deviceType);
                });
            }));
        })
    }

    getTargets(): ResultAsync<Target[], ProcessError> {
        const self = this;
        
        const targetDirectory = "/sys/kernel/scst_tgt/targets/iscsi";

        return this.server.execute(new Command(["find", targetDirectory, ..."-mindepth 1 -maxdepth 1 ( -type d -o -type l ) -printf %f\\0".split(" ")])).map(
            (proc) => {
                const targetNames = proc.getStdout().split("\0").slice(0, -1);
                return targetNames;
            }
        ).andThen((targetNames) => {
            return ResultAsync.combine(targetNames.map((targetName) => {
                return new ResultAsync(safeTry(async function * () {
                    const partialTarget = {
                        name: targetName,  
                        devicePath: targetDirectory + "/" + targetName,
                    };

                    return ok<Target>({
                        ...partialTarget,
                        portals: yield * self.getPortalsOfTarget(partialTarget).safeUnwrap(),
                        chapConfigurations: yield * self.getCHAPConfigurationsOfTarget(partialTarget).safeUnwrap(),
                        initiatorGroups: yield * self.getInitatorGroupsOfTarget(partialTarget).safeUnwrap(),
                        sessions: yield * self.getSessionsOfTarget(partialTarget).safeUnwrap()
                    });
                }))
            }))
        });
    }

    getPortalsOfTarget(target: Pick<Target, "name">): ResultAsync<Portal[], ProcessError> {
        return this.server.execute(new Command(["find", this.getTargetPath(target), ..."-name allowed_portal* -printf %f\\0".split(" ")])).map(
            (proc) => {
                const portalAddressFileNames = proc.getStdout().split("\0").slice(0, -1);
                return portalAddressFileNames;
            }
        ).andThen((portalAddressFileNames) => {
            const addressResults = portalAddressFileNames.map((portalAddressFileName) => {
                const file = new File(this.server, `${this.getTargetPath(target)}/${portalAddressFileName}`)
                return file.read().andThen((fileContent) => {
                    const address = fileContent.split('\n')[0]

                    if (address === undefined)
                        return err(new ProcessError(`Could not parse address from allowed_portal file: ${file.basename}`));

                    return ok(address);
                });
            })

            return ResultAsync.combine(addressResults).map((addresses) => addresses.map((address) => new Portal(address)));
        })
    }

    getInitatorGroupsOfTarget(target: Pick<Target, "name">): ResultAsync<InitiatorGroup[], ProcessError> {
        const self = this;
        const initiatorGroupDirectory = `${this.getTargetPath(target)}/ini_groups`;

        return this.server.execute(new Command(["find", initiatorGroupDirectory, ..."-mindepth 1 -maxdepth 1 ( -type d -o -type l ) -printf %f\\0".split(" ")])).map(
            (proc) => {
                const groupNames = proc.getStdout().split("\0").slice(0, -1);
                return groupNames;
            }
        ).andThen((groupNames) => {
            return ResultAsync.combine(groupNames.map((groupName) => {
                
                return new ResultAsync(safeTry(async function * () {
                    const partialInitiatorGroup = {
                        name: groupName,
                        devicePath: `${initiatorGroupDirectory}/${groupName}`,
                    };

                    return ok<InitiatorGroup>({
                        ...partialInitiatorGroup,
                        initiators: yield * self.getInitiatorsOfInitiatorGroup(partialInitiatorGroup).safeUnwrap(),
                        logicalUnitNumbers: yield * self.getLogicalUnitNumbersOfInitiatorGroup(partialInitiatorGroup).safeUnwrap(),
                    });
                }))
            }))
        });
    }

    getSessionsOfTarget(target: Pick<Target, "name">): ResultAsync<Session[], ProcessError> {
        const self = this;

        const sessionsDirectory = `${this.getTargetPath(target)}/sessions`;

        return new Directory(this.server, sessionsDirectory).exists()
        .andThen((exists) => {
            if (exists)
            {
                return this.server.execute(new Command(["find", sessionsDirectory, ..."-mindepth 1 -maxdepth 1 ( -type d -o -type l ) -printf %f\\0".split(" ")]))
                .map((proc) => proc.getStdout().split("\0").slice(0, -1))
                .andThen((initiatorNames) => {
                    return ResultAsync.combine(initiatorNames.map((initiatorName) => {
                        return new ResultAsync(safeTry(async function * () {
                            const partialSession = {
                                initiatorName: initiatorName,
                                devicePath: `${sessionsDirectory}/${initiatorName}`,
                            };
        
                            return ok<Session>({
                                ...partialSession,
                                readAmountKB:  StringToIntCaster()((yield * self.server.execute(new Command(["cat", `${partialSession.devicePath}/read_io_count_kb`])).safeUnwrap()).getStdout()).some(),
                                writeAmountKB: StringToIntCaster()((yield * self.server.execute(new Command(["cat", `${partialSession.devicePath}/write_io_count_kb`])).safeUnwrap()).getStdout()).some(),
                                connections: yield * self.getConnectionsOfSession(partialSession).safeUnwrap(),
                            });
                        }))
                    }))
                })
            }
            else {
                return ok([]);
            }
        })
    }

    getCHAPConfigurationsOfTarget(target: Pick<Target, "name">): ResultAsync<CHAPConfiguration[], ProcessError> {
        return this.server.execute(new Command(["find", this.getTargetPath(target), ..."-type f ( -name IncomingUser* -o -name OutgoingUser* ) -printf %f\\0".split(" ")])).map(
            (proc) => proc.getStdout().split("\0").slice(0, -1)
        ).andThen((configurationFileNames) => {
            return ResultAsync.combine(configurationFileNames.map((configurationFileName) => {
                const file = new File(this.server, `${this.getTargetPath(target)}/${configurationFileName}`);
                
                return file.read().andThen((fileContent) => {
                    const credentialLine = fileContent.split('\n')[0]

                    if (credentialLine === undefined)
                        return err(new ProcessError(`Could not parse credentials line from CHAP configuration file: ${file.basename}`));

                    const chapType = configurationFileName.includes("IncomingUser") ? CHAPType.IncomingUser : CHAPType.OutgoingUser;
                    const username = credentialLine.split(' ')[0];
                    const password = credentialLine.split(' ')[1];

                    if (username === undefined || password === undefined)
                        return err(new ProcessError(`Could not parse credentials from configuration file: ${file.basename}`));

                    return ok<CHAPConfiguration>({
                        username: username,
                        password: password,
                        chapType: chapType,
                    })
                });
            }));
        })
    }

    getConnectionsOfSession(session: Pick<Session, "devicePath">): ResultAsync<Connection[], ProcessError> {
        const self = this;

        const ignoredNames = ["latency", "lun", "."];

        return this.server.execute(new Command(["find", `${session.devicePath}/`, ..."-type d -mindepth 1 -maxdepth 1 -printf %f\\0".split(" ")])).map(
            (proc) => {
                const connectionFileNames = proc.getStdout().split("\0").slice(0, -1);
                return connectionFileNames.filter(directoryName => 
                    !ignoredNames.some(ignoredName => directoryName.startsWith(ignoredName))
                );
            }
        ).andThen((connectionFileNames) => {
            return ResultAsync.combine(connectionFileNames.map((connectionFileName) => {
                
                return new ResultAsync(safeTry(async function * () {
                    const partialConnection = {
                        devicePath: `${session.devicePath}/${connectionFileName}`
                    };

                    const connectionIDFile = new File(self.server, `${partialConnection.devicePath}/cid`);
                    const ipFile = new File(self.server, `${partialConnection.devicePath}/ip`);

                    return ok<Connection>({
                        ...partialConnection,
                        connectionID: yield * connectionIDFile.read().safeUnwrap(),
                        ipAddress: yield * ipFile.read().safeUnwrap(),
                    });
                }))
            }))
        });
    }
    
    getLogicalUnitNumbersOfInitiatorGroup(initiatorGroup: Pick<InitiatorGroup, "devicePath">): ResultAsync<LogicalUnitNumber[], ProcessError> {
        const self = this;

        const lunsDirectory = `${initiatorGroup.devicePath}/luns`;

        return this.server.execute(new Command(["find", lunsDirectory, ..."-mindepth 1 -maxdepth 1 ( -type d -o -type l ) -printf %f\\0".split(" ")])).map(
            (proc) => {
                return proc.getStdout().split("\0").slice(0, -1);
            }
        ).andThen((numbers) => {
            return ResultAsync.combine(numbers.map((number) => {
                return new ResultAsync(safeTry(async function * () {
                    const partialLogicalUnitNumber = {
                        unitNumber: StringToIntCaster()(number).some(),
                    };

                    const lunDeviceName = (yield * self.server.execute(new Command(["cat", `${lunsDirectory}/${partialLogicalUnitNumber.unitNumber}/device/prod_id`])).safeUnwrap()).getStdout();
                    const device = (yield * self.getVirtualDevices().safeUnwrap()).find((device) => device.deviceName === lunDeviceName);

                    return ok<LogicalUnitNumber>({
                        ...partialLogicalUnitNumber,
                        name: lunDeviceName,
                        blockDevice: device,
                    });
                }))
            }))
        });
    }

    getInitiatorsOfInitiatorGroup(initiatorGroup: Pick<InitiatorGroup, "devicePath">): ResultAsync<Initiator[], ProcessError> {
        const ignoredNames = ["mgmt"];

        const initiatorDirectory = `${initiatorGroup.devicePath}/initiators`;

        return this.server.execute(new Command(["find", initiatorDirectory, ..."-mindepth 1 -maxdepth 1 -printf %f\\0".split(" ")])).map(
            (proc) => {
                const initiatorNames = proc.getStdout().split("\0").slice(0, -1);
                return initiatorNames.filter(name => !ignoredNames.includes(name));
            }
        ).andThen((initiatorNames) => {
            return ResultAsync.combine(initiatorNames.map((initiatorName) => {
                return new ResultAsync(safeTry(async function * () {
                    const partialInitiator = {
                        name: initiatorName,
                    };

                    return ok<Initiator>({
                        ...partialInitiator,
                    });
                }))
            }))
        });
    }

    getTargetPath(target: Pick<Target, "name">) {
        return `${this.targetManagementDirectory}/${target.name}`
    }
}
