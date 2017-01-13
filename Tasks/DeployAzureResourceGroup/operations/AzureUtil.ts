import networkManagementClient = require("./azure-rest/azure-arm-network");
import computeManagementClient = require("./azure-rest/azure-arm-compute");
import deployAzureRG = require("../models/DeployAzureRG");
import tl = require("vsts-task-lib/task")

export class NetworkInterface {
    Name: string;
    Id: string
}

export class VirtualMachine {
    Name: string;
    NetworkInterfaces: NetworkInterface[];
    WinRMHttpsPort: number;
    WinRMHttpsPublicAddress: string;
    Tags: any;

    constructor() {
        this.NetworkInterfaces = [];
    }
}

export class LoadBalancer {
    Name: string;
    FrontEndPublicAddress: string
    FrontEndPortsInUse: number[];
    BackendNicIds: string[];

    constructor() {
        this.BackendNicIds = [];
        this.FrontEndPortsInUse = [];
    }
}

export class ResourceGroupDetails {
    VirtualMachines: VirtualMachine[];
    LoadBalancers: LoadBalancer[]

    constructor() {
        this.VirtualMachines = [];
        this.LoadBalancers = []
    }
}

export class AzureUtil {
    private taskParameters: deployAzureRG.AzureRGTaskParameters;
    private loadBalancersDetails;
    private vmDetails: any[];
    private networkInterfaceDetails;
    private publicAddressDetails;
    private networkClient: networkManagementClient.NetworkManagementClient;
    private computeClient: computeManagementClient.ComputeManagementClient;

    constructor(taskParameters: deployAzureRG.AzureRGTaskParameters) {
        this.taskParameters = taskParameters;
        this.computeClient = new computeManagementClient.ComputeManagementClient(this.taskParameters.credentials, this.taskParameters.subscriptionId);
        this.networkClient = new networkManagementClient.NetworkManagementClient(this.taskParameters.credentials, this.taskParameters.subscriptionId);
    }

    public async getResourceGroupDetails(): Promise<ResourceGroupDetails> {
        await this.getDetails();
        var resourceGroupDetails = new ResourceGroupDetails();

        var fqdns = {}
        for (var publicAddress of this.publicAddressDetails) {
            fqdns[publicAddress["id"]] = publicAddress["dnsSettings"]
                ? publicAddress["dnsSettings"]["fqdn"]
                : publicAddress["ipAddress"];
        }

        var ipcToNicMap = {}
        for (var nic in this.networkInterfaceDetails) {
            for (var ipc of nic["properties"]["ipConfigurations"]) {
                ipcToNicMap[ipc["id"]] = nic["name"];
            }
        }

        var ruleToFrontEndPortMap = {}
        for (var lb of this.loadBalancersDetails) {
            var loadBalancer = new LoadBalancer();
            var publicAddressId = lb["properties"]["frontendIPConfigurations"][0]["properties"]["publicIPAddress"]["id"];
            loadBalancer.FrontEndPublicAddress = fqdns[publicAddressId];
            loadBalancer.Name = lb["name"];

            for (var rule of lb.properties["inboundNatRules"]) {
                loadBalancer.FrontEndPortsInUse.push(rule["properties"]["fronendPort"]);
                if (rule["properties"]["backendPort"] === 5986 && rule["properties"]["backendIPConfiguration"] && rule["properties"]["backendIPConfiguration"]["id"]) {
                    ruleToFrontEndPortMap[rule["id"]] = {
                        FrontEndPort: rule["properties"]["fronendPort"],
                        PublicAddress: loadBalancer.FrontEndPublicAddress
                    }
                }
            }

            for (var pool of lb["properties"]["backendAddressPools"]) {
                var ipConfigs = pool["properties"]["backendIPConfigurations"];
                if (ipConfigs) {
                    for (var ipc of ipConfigs) {
                        loadBalancer.BackendNicIds.push(ipcToNicMap[ipc["id"]]);
                    }
                }
            }

            resourceGroupDetails.LoadBalancers.push(loadBalancer);
        }

        for (var vmDetail of this.vmDetails) {
            var virtualMachine = new VirtualMachine();
            virtualMachine.Name = vmDetail["name"];
            virtualMachine.Tags = vmDetail["tags"];
            var networkInterfaces = vmDetail["properties"]["networkProfile"]["networkInterfaces"];
            if (vmDetail["properties"]["networkProfile"]) {
                for (var networkInterface of vmDetail["properties"]["networkProfile"]["networkInterfaces"]) {
                    for (var ipc of networkInterface["properties"]["ipConfigurations"]) {
                        if (ipc["properties"]["publicIPAddress"] && fqdns[ipc["properties"]["publicIPAddress"]["id"]]) {
                            virtualMachine.WinRMHttpsPort = 5986;
                            virtualMachine.WinRMHttpsPublicAddress = fqdns[ipc["properties"]["publicIPAddress"]["id"]];
                            break;
                        }
                    }

                    if (virtualMachine.WinRMHttpsPublicAddress) {
                        break;
                    }

                    for (var rule of networkInterface["properties"]["inboundNatRules"]) {
                        if (ruleToFrontEndPortMap[rule["id"]]) {
                            virtualMachine.WinRMHttpsPort = ruleToFrontEndPortMap[rule["id"]].FrontEndPort;
                            virtualMachine.WinRMHttpsPublicAddress = ruleToFrontEndPortMap[rule["id"]].PublicAddress;
                            break;
                        }
                    }

                    if (virtualMachine.WinRMHttpsPublicAddress) {
                        break;
                    }
                }
            }

            resourceGroupDetails.VirtualMachines.push(virtualMachine);
        }

        return resourceGroupDetails;
    }

    private getDetails(): Promise<any[]> {
        var details = [this.getLoadBalancers(), this.getNetworkInterfaceDetails(), this.getPublicIPAddresses(), this.getVMDetails()];
        return Promise.all(details);
    }

    private getLoadBalancers(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.networkClient.loadBalancers.list(this.taskParameters.resourceGroupName, (error, loadbalancers, request, response) => {
                if (error) {
                    reject(tl.loc("FailedToFetchLoadBalancers", error));
                }
                this.loadBalancersDetails = loadbalancers;
                resolve(loadbalancers);
            });
        });
    }

    private getVMDetails(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.computeClient.virtualMachines.list(this.taskParameters.resourceGroupName, null, (error, virtualMachines, request, response) => {
                if (error) {
                    tl.error(error);
                    reject(tl.loc("FailedToFetchVMs"));
                }
                this.vmDetails = virtualMachines;
                resolve(virtualMachines);
            });
        });
    }

    private getNetworkInterfaceDetails(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.networkClient.networkInterfaces.list(this.taskParameters.resourceGroupName, null, (error, networkInterfaces, request, response) => {
                if (error) {
                    tl.error(error);
                    reject(tl.loc("FailedToFetchNetworkInterfaces"));
                }
                this.networkInterfaceDetails = networkInterfaces;
                resolve(networkInterfaces);
            });
        });
    }

    private getPublicIPAddresses(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.networkClient.publicIPAddresses.list(this.taskParameters.resourceGroupName, null, (error, publicAddresses, request, response) => {
                if (error) {
                    tl.error(error);
                    reject(tl.loc("FailedToFetchPublicAddresses"));
                }
                this.publicAddressDetails = publicAddresses;
                resolve(publicAddresses);
            });
        });
    }
}
