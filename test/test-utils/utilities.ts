/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { ReactWrapper } from "enzyme";
import EventEmitter from "events";

export const emitPromise = (e: EventEmitter, k: string | symbol) => new Promise(r => e.once(k, r));

const findByAttr = (attr: string) => (component: ReactWrapper, value: string) => component.find(`[${attr}="${value}"]`);
export const findByTestId = findByAttr('data-test-id');
export const findById = findByAttr('id');

const findByTagAndAttr = (attr: string) =>
    (component: ReactWrapper, value: string, tag: string) =>
        component.find(`${tag}[${attr}="${value}"]`);

export const findByTagAndTestId = findByTagAndAttr('data-test-id');

export const flushPromises = async () => await new Promise(resolve => setTimeout(resolve));

/**
 * Call fn before calling componentDidUpdate on a react component instance, inst.
 * @param {React.Component} inst an instance of a React component.
 * @param {number} updates Number of updates to wait for. (Defaults to 1.)
 * @returns {Promise} promise that resolves when componentDidUpdate is called on
 *                    given component instance.
 */
export function waitForUpdate(inst: React.Component, updates = 1): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const cdu = inst.componentDidUpdate;

        console.log(`Waiting for ${updates} update(s)`);

        inst.componentDidUpdate = (prevProps, prevState, snapshot) => {
            updates--;
            console.log(`Got update, ${updates} remaining`);

            if (updates == 0) {
                inst.componentDidUpdate = cdu;
                resolve();
            }

            if (cdu) cdu(prevProps, prevState, snapshot);
        };
    });
}
